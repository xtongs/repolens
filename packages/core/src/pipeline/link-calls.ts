import type { Db } from "../db/database.js";
import type { EdgeRow } from "../db/writer.js";
import { resolverFamily, type ResolverFamily } from "../discovery/language.js";
import type { Confidence, Language } from "../types.js";
import { builtinType, isBuiltinFunction, isBuiltinReceiver } from "./builtins.js";

/**
 * 调用点 → 符号级调用边。
 *
 * 这是整个项目里最容易产生「看起来很确定的错边」的地方，所以每条边都必须
 * 带上置信度，而且判定顺序是从「语言语义能证明的」逐级降到「靠名字猜的」：
 *
 *   exact      同文件定义 / this.x 命中同一个类 / import 链能一路走到定义
 *   likely     有文件级证据但没有符号级证据（Go 同包、Python/Rust 通配导入、
 *              import 指到了文件但对方没有显式导出这个名字）
 *   ambiguous  同名候选不止一个，候选 id 一并存下来交给界面
 *   external   调用目标来自第三方或标准库
 *   unresolved 什么都没匹配上，不产生边
 *
 * 「全仓唯一同名」只在没有模块解析器的语言里兜底。TS/JS、Python、Rust 的
 * 跨文件调用必须经过 import，没有 import 证据的同名命中几乎全是巧合——
 * 局部变量 `run()` 会被连到另一个包里恰好导出的 `run`，而且跨越了架构边界。
 *
 * 方法调用的接收者类型来自解析器记下的线索（参数标注、`new`、`as`、局部变量
 * 的初值）或调用者的参数表；链式调用接在前一个调用的结果上。这些都不是完整的
 * 类型推导，推不出来就照旧走名字匹配，不会因此多出一条确定的错边。
 *
 * unresolved 不落边是有意的：`console.log` 这类占了调用点的大头，
 * 把它们画进图里只会淹没真正的结构。统计数字仍然会报出来。
 */

export interface CallLinkStats {
  callSites: number;
  edges: number;
  byConfidence: Record<Confidence, number>;
}

interface Binding {
  /** import 解析到的目标文件；Go 的包级 import 没有文件粒度，为 null */
  targetFileId: number | null;
  /** Go 包级 import 落在的目录 */
  targetDir: string | null;
  externalName: string | null;
  /** 在目标模块里的原名，与本地别名区分 */
  imported: string;
  isNamespace: boolean;
}

interface FileScope {
  family: ResolverFamily | undefined;
  dir: string;
  packageId: number | null;
  /** 本文件顶层定义：名字 → 符号 id */
  locals: Map<string, number[]>;
  /** 本文件的成员：`容器.名字` → 符号 id */
  members: Map<string, number[]>;
  /** import 的本地名 → 绑定 */
  bindings: Map<string, Binding>;
  /** `export * from` / `from x import *` / `use x::*` 指向的文件 */
  stars: number[];
  /** 本文件能看见的类型名：本地声明的 + import 进来的 */
  visibleTypes: Set<string>;
}

export function linkCallEdges(db: Db, insert: (edges: EdgeRow[]) => void): CallLinkStats {
  const index = buildIndex(db);
  const stats: CallLinkStats = {
    callSites: 0,
    edges: 0,
    byConfidence: { exact: 0, likely: 0, ambiguous: 0, external: 0, unresolved: 0 },
  };

  // 同一个 (调用者, 被调者) 出现多次只留一条边，次数记在 weight 上。
  // 一个循环里调 10 次同一个函数，在图上和调 1 次是同一条关系。
  const merged = new Map<string, EdgeRow>();

  // 按文件内的结束位置排，链式调用 `a.b().c()` 处理到 c 时 b 已经有结果了
  const rows = db
    .prepare(
      `SELECT c.id, c.file_id AS fileId, c.caller_symbol_id AS callerId, c.callee_name AS callee,
              c.receiver, c.receiver_type AS receiverType, c.callee_path AS calleePath,
              c.call_kind AS callKind, c.line
       FROM call_sites c ORDER BY c.file_id, c.end_byte`,
    )
    .all() as Array<CallRow & { id: number; line: number }>;
  const record = db.prepare(
    `UPDATE call_sites SET resolution = @confidence, target_symbol_id = @symbolId,
       target_name = @externalName, candidates = @candidates
     WHERE id = @id`,
  );

  let priorFile = -1;
  let prior: PriorCall[] = [];
  for (const row of rows) {
    stats.callSites++;
    if (row.fileId !== priorFile) {
      priorFile = row.fileId;
      prior = [];
    }
    const scope = index.scopes.get(row.fileId);
    const inner = row.receiver?.includes("(") && row.receiverType === null ? innerCallOf(prior, row) : null;
    const target =
      (inner ? chainedOn(index, inner.resolution, row.callee) : null) ?? resolveCall(index, scope, row, 0, prior);
    prior.push({ callerId: row.callerId, receiver: row.receiver, callee: row.callee, resolution: target });
    if (prior.length > 512) prior = prior.slice(-256);
    stats.byConfidence[target.confidence]++;
    record.run({
      id: row.id,
      confidence: target.confidence,
      symbolId: target.symbolId,
      externalName: target.externalName,
      candidates: target.candidates ? JSON.stringify(target.candidates) : null,
    });
    if (target.confidence === "unresolved") continue;

    // 调用者可能是模块顶层代码，这时归到文件头上而不是编一个假的调用者
    const srcKind = row.callerId !== null ? "symbol" : "file";
    const srcId = row.callerId ?? row.fileId;
    if (srcKind === "symbol" && target.symbolId === srcId) continue; // 自递归不入图

    const dstKey = target.symbolId !== null ? `s${target.symbolId}` : `e${target.externalName}`;
    const key = `${srcKind}${srcId}\u0000${dstKey}`;
    const existing = merged.get(key);
    if (existing) {
      existing.weight++;
      continue;
    }

    merged.set(key, {
      type: "calls",
      srcKind,
      srcId,
      dstKind: target.symbolId !== null ? "symbol" : "external",
      dstId: target.symbolId,
      dstName: target.externalName,
      confidence: target.confidence,
      line: row.line,
      callKind: row.callKind,
      candidates: target.candidates,
      weight: 1,
    });
  }

  const edges = [...merged.values()];
  insert(edges);
  stats.edges = edges.length;
  return stats;
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

interface Resolution {
  confidence: Confidence;
  symbolId: number | null;
  externalName: string | null;
  candidates: number[] | null;
}

const UNRESOLVED: Resolution = {
  confidence: "unresolved",
  symbolId: null,
  externalName: null,
  candidates: null,
};

interface CallRow {
  fileId: number;
  callerId: number | null;
  callee: string;
  receiver: string | null;
  /** 解析器记下的接收者类型线索，见 `receiverHint` */
  receiverType: string | null;
  calleePath: string | null;
  callKind: string;
}

/** 推返回值类型时会递归解析别的调用，层数封顶防止别名或互相返回的类型绕圈 */
const MAX_TYPE_DEPTH = 3;

function resolveCall(
  index: RepoIndex,
  scope: FileScope | undefined,
  row: CallRow,
  depth: number,
  prior: readonly PriorCall[] = [],
): Resolution {
  const isMethod = row.receiver !== null && row.receiver.length > 0;

  if (isMethod) {
    const receiver = row.receiver as string;

    // this.foo() —— 唯一能靠语法确定接收者类型的方法调用
    if (receiver === "this" || receiver === "self" || receiver === "Self" || receiver === "cls") {
      const container = row.callerId !== null ? index.containerOf.get(row.callerId) : undefined;
      if (container && scope) {
        const hit = scope.members.get(`${container}.${row.callee}`);
        if (hit && hit.length > 0) return exact(hit[0] as number);
        const decl = index.typesOf.get(row.fileId)?.get(container);
        const inherited = decl ? methodViaParents(index, decl, row.callee, depth) : null;
        if (inherited) return inherited;
      }
    }
    if (receiver === "super" || receiver === "super()") {
      const container = row.callerId !== null ? index.containerOf.get(row.callerId) : undefined;
      const decl = container ? index.typesOf.get(row.fileId)?.get(container) : undefined;
      const inherited = decl ? methodViaParents(index, decl, row.callee, depth) : null;
      if (inherited) return inherited;
    }

    const head = receiver.split(/\.|::/)[0] as string;
    if (!scope?.bindings.has(head) && isBuiltinReceiver(scope?.family, head)) {
      return external(head);
    }

    // 命名空间导入：import * as fs → fs.readFile()；Go 的 pkg.Func()；
    // Python 的 `import a.b` 绑定的是完整点分名
    const binding = scope?.bindings.get(receiver) ?? scope?.bindings.get(head);
    if (binding?.isNamespace) {
      if (binding.externalName !== null) return external(binding.externalName);
      if (binding.targetFileId !== null) {
        const hit = resolveImported(index, binding.targetFileId, row.callee);
        if (hit) return hit;
      }
      if (binding.targetDir !== null) {
        const hit = byPackage(index.topLevelByDir.get(binding.targetDir)?.get(row.callee), "exact");
        if (hit) return hit;
      }
    }

    // 接收者就是成员的宿主：本文件的 `api.load()` / `Foo.create()`，
    // 或者 `import { api } from "./client"` 之后的 `api.load()`
    if (scope && !receiver.includes(".")) {
      const hit = binding
        ? binding.isNamespace || binding.targetFileId === null
          ? null
          : resolveMember(index, binding.targetFileId, binding.imported, row.callee, new Set())
        : uniqueOf(scope.members.get(`${receiver}.${row.callee}`));
      if (hit !== null) return exact(hit);
    }

    if (scope && depth < MAX_TYPE_DEPTH) {
      const typed = receiverTypeOf(index, scope, row, depth, prior);
      if (typed) {
        const hit = methodOnType(index, typed.type, row.callee, depth);
        if (hit) return typed.inferred ? downgrade(hit) : hit;
      }
    }

    // 推不出返回值类型时，接在调用结果上的 then / catch / finally 几乎只会是 Promise
    if (receiver.includes("(") && (row.callee === "then" || row.callee === "catch" || row.callee === "finally")) {
      return external("Promise");
    }

    // 接收者是个普通变量，类型未知。候选池要同时满足两个条件：是方法，
    // 且宿主类在本文件可见（本地定义或 import 进来）。少了后一条，
    // `arr.push(x)` 会连到仓库里任意一个恰好叫 push 的用户方法上——
    // 在 pi 上这一类假边有一千多条，而它们全都指向毫不相干的类。
    return byName(visibleMethods(index, scope, row.callee));
  }

  // ---- 普通函数调用 ----

  if (!scope) return byName(index.exportedByName.get(row.callee));

  const local = scope.locals.get(row.callee);
  if (local && local.length === 1) return exact(local[0] as number);
  if (local && local.length > 1) {
    return { confidence: "ambiguous", symbolId: local[0] as number, externalName: null, candidates: local };
  }

  const binding = scope.bindings.get(row.callee);
  if (binding) {
    if (binding.externalName !== null) return external(binding.externalName);
    if (binding.targetFileId !== null) {
      const name = binding.isNamespace ? row.callee : binding.imported;
      const hit = resolveImported(index, binding.targetFileId, name, row.callee);
      if (hit) return hit;
    }
  }

  const builtin = isBuiltinFunction(scope.family, row.callee) ? external(row.callee) : UNRESOLVED;
  switch (scope.family) {
    case "ts":
      // 没有 import 就不可能调用到别的文件里的函数
      return builtin;
    case "python":
    case "rust": {
      const hit = fromStars(index, scope, row.callee);
      return hit.confidence === "unresolved" ? builtin : hit;
    }
    case "go": {
      // Go 裸调用只可能落在同包（同目录）或点导入的包里；同包定义可以遮住 len、copy 这类内置
      const samePackage = index.topLevelByDir.get(scope.dir)?.get(row.callee);
      const hit = byPackage(samePackage, "likely");
      if (hit) return hit;
      const dot = scope.bindings.get(".");
      if (dot?.targetDir) {
        return byPackage(index.topLevelByDir.get(dot.targetDir)?.get(row.callee), "likely") ?? builtin;
      }
      return builtin;
    }
    default:
      return byName(index.exportedByName.get(row.callee));
  }
}

// ---------------------------------------------------------------------------
// 接收者类型
// ---------------------------------------------------------------------------

type TypeRef = { kind: "external"; name: string } | { kind: "repo"; decl: TypeDecl };

interface TypeDecl {
  id: number;
  fileId: number;
  name: string;
  kind: string;
  signature: string | null;
}

interface PriorCall {
  callerId: number | null;
  receiver: string | null;
  callee: string;
  resolution: Resolution;
}

/**
 * 接收者的类型。`inferred` 表示类型是从返回值推出来的而不是写在源码里的：
 * 返回类型标注可能比实际宽（返回接口、返回父类），落到的方法只能算 likely。
 */
function receiverTypeOf(
  index: RepoIndex,
  scope: FileScope,
  row: CallRow,
  depth: number,
  prior: readonly PriorCall[],
): { type: TypeRef; inferred: boolean } | null {
  // TS 的线索由解析器顺着作用域找，已经处理了内层同名参数遮住外层的情况；参数表兜底只给别的语言
  const hint = row.receiverType ?? (scope.family === "ts" ? null : paramHint(index, row));
  return hint === null ? null : typeOfHint(index, scope, row, hint, depth, prior);
}

/** 回调参数是集合元素或 Promise 的结果，不是注册方所在库的对象 */
const COLLECTION_METHODS = new Set([
  "map", "forEach", "filter", "reduce", "reduceRight", "find", "findIndex", "findLast", "some", "every", "flatMap",
  "sort", "then", "catch", "finally", "replace", "replaceAll",
]);

function typeOfHint(
  index: RepoIndex,
  scope: FileScope,
  row: CallRow,
  hint: string,
  depth: number,
  prior: readonly PriorCall[],
): { type: TypeRef; inferred: boolean } | null {
  if (depth > MAX_TYPE_DEPTH + 2) return null;
  const body = hint.slice(2);
  if (hint.startsWith("T:")) {
    const type = resolveTypeName(index, row.fileId, body, false, depth);
    return type ? { type, inferred: false } : null;
  }
  // M: 是属性链 `c.req`，后面跟根变量的线索。只信写明的类型和回调参数：
  // 从返回值推出来的根多半是普通数据，属性不再属于那个库
  if (hint.startsWith("M:")) {
    if (!/^[TC]:/.test(body)) return null;
    const root = typeOfHint(index, scope, row, body, depth + 1, prior);
    return root?.type.kind === "external" ? root : null;
  }
  // C: 是没标类型的回调参数，`方法名|注册方的线索`
  if (hint.startsWith("C:")) {
    const bar = body.indexOf("|");
    const method = body.slice(0, bar);
    if (bar < 0 || COLLECTION_METHODS.has(method)) return null;
    const owner = typeOfHint(index, scope, row, body.slice(bar + 1), depth + 1, prior);
    const hit = owner ? methodOnType(index, owner.type, method, depth + 1) : null;
    if (hit?.confidence !== "external" || hit.externalName === null || !index.importedExternals.has(hit.externalName)) {
      return null;
    }
    return { type: { kind: "external", name: hit.externalName }, inferred: true };
  }
  if (!hint.startsWith("R:") && !hint.startsWith("A:")) return null;
  // R: 是 `const x = f()` 里 f 的路径，A: 是被 await 过的。初值里那次调用一般已经解析过，
  // 它带着自己的接收者线索，比按路径重新解析准
  const segments = body.split(".");
  const call: CallRow = {
    fileId: row.fileId,
    callerId: row.callerId,
    callee: segments.at(-1) as string,
    receiver: segments.length > 1 ? segments.slice(0, -1).join(".") : null,
    receiverType: null,
    calleePath: body,
    callKind: "call",
  };
  const earlier = findPrior(prior, call);
  const resolution = earlier?.resolution ?? resolveCall(index, scope, call, depth + 1);
  const type = returnTypeOf(index, resolution, hint.startsWith("A:"), depth);
  return type ? { type, inferred: true } : null;
}

function findPrior(prior: readonly PriorCall[], call: CallRow): PriorCall | null {
  for (let i = prior.length - 1; i >= 0 && i >= prior.length - 256; i--) {
    const candidate = prior[i] as PriorCall;
    if (candidate.callee === call.callee && candidate.receiver === call.receiver) return candidate;
  }
  return null;
}

/** 接收者是调用者的参数时，参数表里的类型标注；Go 方法的接收者变量也算 */
function paramHint(index: RepoIndex, row: CallRow): string | null {
  if (row.callerId === null || row.receiver === null || !/^[A-Za-z_$][\w$]*$/.test(row.receiver)) return null;
  const type = paramTypesOf(index, row.callerId).get(row.receiver);
  return type ? `T:${type}` : null;
}

function paramTypesOf(index: RepoIndex, symbolId: number): Map<string, string> {
  const cached = index.paramTypeCache.get(symbolId);
  if (cached) return cached;
  const out = new Map<string, string>();
  const info = index.symbolInfo.get(symbolId);
  if (info?.params) {
    try {
      for (const param of JSON.parse(info.params) as Array<{ name?: string; type?: string | null }>) {
        if (param.name && param.type) out.set(param.name, param.type);
      }
    } catch {
      // 旧索引里的 params 可能不是 JSON，当作没有标注
    }
  }
  const goReceiver = info?.signature?.match(/^func\s*\(\s*(\w+)\s+\*?\s*([\w.]+)/);
  if (goReceiver) out.set(goReceiver[1] as string, goReceiver[2] as string);
  index.paramTypeCache.set(symbolId, out);
  return out;
}

/**
 * 一次调用的结果类型：调到类就是它的实例，调到函数看返回类型标注。
 * 外部库函数的返回值看不到类型，但接着调的方法也属于那个库，归给它比报「确定不了」更有用。
 */
function returnTypeOf(index: RepoIndex, resolution: Resolution, awaited: boolean, depth: number): TypeRef | null {
  if (resolution.confidence === "external" && resolution.externalName !== null) {
    return { kind: "external", name: resolution.externalName };
  }
  if (resolution.symbolId === null || resolution.confidence === "ambiguous") return null;
  const decl = index.typeById.get(resolution.symbolId);
  if (decl) return { kind: "repo", decl };
  const info = index.symbolInfo.get(resolution.symbolId);
  if (!info?.returnType) return null;
  return resolveTypeName(index, info.fileId, info.returnType, awaited, depth + 1);
}

/** 链式调用 `a.b(x).c()` 里 c 接在哪次调用的结果上：接收者以那次调用开头、离得最近的那个 */
function innerCallOf(prior: readonly PriorCall[], row: CallRow): PriorCall | null {
  const receiver = row.receiver as string;
  for (let i = prior.length - 1; i >= 0 && i >= prior.length - 64; i--) {
    const call = prior[i] as PriorCall;
    if (call.callerId !== row.callerId) continue;
    const prefix = `${call.receiver ? `${call.receiver}.` : ""}${call.callee}(`;
    if (receiver.startsWith(prefix)) return call;
  }
  return null;
}

function chainedOn(index: RepoIndex, inner: Resolution, callee: string): Resolution | null {
  const type = returnTypeOf(index, inner, false, 0);
  const hit = type ? methodOnType(index, type, callee, 0) : null;
  return hit ? downgrade(hit) : null;
}

/** 类型标注 → 能查到方法的宿主：仓库里声明的类型，或者某个外部库 / 语言内置 */
function resolveTypeName(index: RepoIndex, fileId: number, text: string, awaited: boolean, depth: number): TypeRef | null {
  if (depth > MAX_TYPE_DEPTH + 2) return null;
  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  const name = simplifyType(text, scope.family, awaited);
  if (name === null) return null;
  const segments = name.split(/\.|::/);
  const head = segments[0] as string;

  if (segments.length === 1) {
    const local = index.typesOf.get(fileId)?.get(head);
    if (local) return followAlias(index, local, depth);
    const binding = scope.bindings.get(head);
    if (binding) {
      if (binding.externalName !== null) return { kind: "external", name: binding.externalName };
      if (binding.targetFileId !== null && !binding.isNamespace) {
        const defaultId = binding.imported === "default" ? index.defaultExportOf.get(binding.targetFileId) : undefined;
        const decl =
          (defaultId !== undefined ? index.typeById.get(defaultId) : undefined) ??
          exportedType(index, binding.targetFileId, binding.imported === "default" ? head : binding.imported, new Set());
        return decl ? followAlias(index, decl, depth) : null;
      }
    }
    if (scope.family === "go") {
      const decl = index.typesByDir.get(scope.dir)?.get(head);
      if (decl) return followAlias(index, decl, depth);
    }
    const builtin = builtinType(scope.family, head);
    if (builtin) return { kind: "external", name: builtin };
    // TS 里没声明也没 import 的大写类型名来自全局声明（lib.dom、@types/node）；
    // 单字母和 TItem 这种是泛型参数，不是具体类型
    if (scope.family === "ts" && /^[A-Z]/.test(head) && !/^[A-Z]$|^T[A-Z]/.test(head)) {
      return { kind: "external", name: head };
    }
    return null;
  }

  const member = segments[1] as string;
  const binding = scope.bindings.get(head);
  if (binding) {
    if (binding.externalName !== null) return { kind: "external", name: binding.externalName };
    if (binding.targetFileId !== null && binding.isNamespace) {
      const decl = exportedType(index, binding.targetFileId, member, new Set());
      return decl ? followAlias(index, decl, depth) : null;
    }
    if (binding.targetDir !== null) {
      const decl = index.typesByDir.get(binding.targetDir)?.get(member);
      return decl ? followAlias(index, decl, depth) : null;
    }
    return null;
  }
  if (isBuiltinReceiver(scope.family, head)) return { kind: "external", name: head };
  if (scope.family === "ts" && /^[A-Z]/.test(head)) return { kind: "external", name: head };
  return null;
}

/** `type Db = Database.Database` 这类别名要追到右边；Go 的 `type Handler func()` 本身就能挂方法 */
function followAlias(index: RepoIndex, decl: TypeDecl, depth: number): TypeRef | null {
  if (decl.kind !== "type") return { kind: "repo", decl };
  const rhs = decl.signature?.match(/=\s*([\s\S]+?);?\s*$/)?.[1];
  if (rhs === undefined) return { kind: "repo", decl };
  return resolveTypeName(index, decl.fileId, rhs, false, depth + 1);
}

/** 沿 import / re-export 找到声明这个类型的文件 */
function exportedType(index: RepoIndex, fileId: number, name: string, seen: Set<number>): TypeDecl | null {
  if (seen.has(fileId) || seen.size > 24) return null;
  seen.add(fileId);
  const direct = index.typesOf.get(fileId)?.get(name);
  if (direct) return direct;
  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  const binding = scope.bindings.get(name);
  if (binding && !binding.isNamespace && binding.targetFileId !== null) {
    const hit = exportedType(index, binding.targetFileId, binding.imported, seen);
    if (hit) return hit;
  }
  for (const target of scope.stars) {
    const hit = exportedType(index, target, name, seen);
    if (hit) return hit;
  }
  return null;
}

/**
 * 把类型标注化简成一个可查的名字：去掉可空、引用、指针和泛型参数。
 * 联合、交叉、函数和对象字面量类型落不到单一宿主上，返回 null。
 */
function simplifyType(text: string, family: ResolverFamily | undefined, awaited: boolean): string | null {
  let type = text.replace(/\s+/g, " ").trim().replace(/^:\s*/, "");
  for (let guard = 0; guard < 8; guard++) {
    const before = type;
    if (/^(typeof|keyof) /.test(type)) return null;
    type = type.replace(/^(readonly|unique) /, "");
    type = type.replace(/^&\s*('\w+\s+)?(mut\s+)?|^\*+\s*|^(dyn|impl|mut) /, "");
    // Python 的前向引用写成字符串：`def f(x: "Store")`
    if (family === "python") type = type.replace(/^(["'])(.*)\1$/, "$2");
    if (type.startsWith("(") && type.endsWith(")") && splitTopLevel(type.slice(1, -1), ",").length === 1) {
      type = type.slice(1, -1).trim();
    }
    const parts = splitTopLevel(type, "|").map((p) => p.trim()).filter((p) => !/^(null|undefined|void|None)$/.test(p));
    if (parts.length !== 1) return null;
    type = parts[0] as string;
    if (splitTopLevel(type, "&").length > 1 || hasTopLevelArrow(type) || type.startsWith("{")) return null;

    if (type.endsWith("[]")) return family === "ts" ? "Array" : null;
    // TS 里 `X["key"]` 是索引访问类型，不是泛型；方括号泛型只有 Python / Go 用
    if (family === "ts" && type.endsWith("]")) return null;
    const generic = type.match(/^([\w$.:]+)\s*[<[]([\s\S]*)[>\]]$/);
    if (generic) {
      const base = generic[1] as string;
      const args = splitTopLevel(generic[2] as string, ",");
      const unwrap =
        (awaited && (base === "Promise" || base === "PromiseLike")) ||
        (family === "python" && (base === "Optional" || base === "Annotated" || base === "typing.Optional")) ||
        (family === "rust" && (base === "Box" || base === "Rc" || base === "Arc"));
      type = unwrap ? (args[0] ?? "").trim() : base;
    }
    if (type === before) break;
  }
  return /^[A-Za-z_$][\w$]*((\.|::)[A-Za-z_$][\w$]*)*$/.test(type) ? type : null;
}

function hasTopLevelArrow(text: string): boolean {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ">" && text[i - 1] !== "=") || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === "=" && text[i + 1] === ">") return true;
  }
  return false;
}

function splitTopLevel(text: string, separator: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "<" || ch === "(" || ch === "[" || ch === "{") depth++;
    else if ((ch === ">" && text[i - 1] !== "=") || ch === ")" || ch === "]" || ch === "}") depth--;
    else if (depth === 0 && ch === separator) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * 在类型上找方法：先看自己，再沿 extends / embeds 往上。接口和 trait 自己没有实现，
 * 落到实现它的类上；实现不止一个时交给界面挑。
 */
function methodOnType(index: RepoIndex, type: TypeRef, callee: string, depth: number): Resolution | null {
  if (type.kind === "external") return external(type.name);
  const { decl } = type;
  const own = membersOf(index, decl, callee);
  if (decl.kind === "interface" || decl.kind === "trait") {
    const hits = [...new Set(
      (index.implementersOf.get(decl.id) ?? [])
        .map((id) => index.typeById.get(id))
        .map((impl) => (impl ? membersOf(index, impl, callee).at(-1) : undefined))
        .filter((id): id is number => id !== undefined),
    )];
    if (hits.length === 1) return likely(hits[0] as number);
    if (hits.length > 1) return byName(hits);
    if (own.length > 0) return likely(own.at(-1) as number);
    return methodViaParents(index, decl, callee, depth);
  }
  // TS 重载签名排在实现前面，最后一个才是有函数体的那个
  if (own.length > 0) return exact(own.at(-1) as number);
  return methodViaParents(index, decl, callee, depth);
}

function methodViaParents(index: RepoIndex, decl: TypeDecl, callee: string, depth: number): Resolution | null {
  if (depth > MAX_TYPE_DEPTH + 2) return null;
  for (const parent of index.parentsOf.get(decl.id) ?? []) {
    const type =
      resolveTypeName(index, decl.fileId, parent.target, false, depth + 1) ??
      (parent.targetId !== null && index.typeById.has(parent.targetId)
        ? { kind: "repo" as const, decl: index.typeById.get(parent.targetId) as TypeDecl }
        : null);
    if (!type || (type.kind === "repo" && type.decl.id === decl.id)) continue;
    const hit = methodOnType(index, type, callee, depth + 1);
    if (hit) return hit;
  }
  return null;
}

/** 类型的成员：同文件优先；Go 的方法可以写在同包的别的文件里，Rust 的 impl 可以在同 crate 的任何地方 */
function membersOf(index: RepoIndex, decl: TypeDecl, callee: string): number[] {
  const all = index.membersByKey.get(`${decl.name}.${callee}`);
  if (!all) return [];
  const home = index.scopes.get(decl.fileId);
  const sameFile = all.filter((id) => index.symbolInfo.get(id)?.fileId === decl.fileId);
  if (sameFile.length > 0 || !home) return sameFile;
  return all.filter((id) => {
    const scope = index.scopes.get(index.symbolInfo.get(id)?.fileId ?? -1);
    if (!scope) return false;
    if (home.family === "go") return scope.dir === home.dir;
    return home.family === "rust" && home.packageId !== null && scope.packageId === home.packageId;
  });
}

function downgrade(resolution: Resolution): Resolution {
  return resolution.confidence === "exact" ? { ...resolution, confidence: "likely" } : resolution;
}

/**
 * import 指到了具体文件：沿导出、`export { a } from`、`export * from` 追到定义。
 * 追不到但目标文件顶层恰好有这个名字（CommonJS 的 `module.exports = { foo }`、
 * 抽取器没认出的导出形式）时给 likely——文件关系已被 import 证明，符号关系没有。
 */
function resolveImported(
  index: RepoIndex,
  targetFileId: number,
  name: string,
  localName?: string,
): Resolution | null {
  const hit = resolveExport(index, targetFileId, name, new Set());
  if (hit !== null) return exact(hit);
  const locals = index.scopes.get(targetFileId)?.locals;
  const fallback = locals?.get(name === "default" ? (localName ?? name) : name);
  if (fallback && fallback.length === 1) return likely(fallback[0] as number);
  return null;
}

function resolveExport(index: RepoIndex, fileId: number, name: string, seen: Set<number>): number | null {
  if (seen.has(fileId) || seen.size > 24) return null;
  seen.add(fileId);

  const direct = name === "default" ? index.defaultExportOf.get(fileId) : index.exportsOf.get(fileId)?.get(name);
  if (direct !== undefined) return direct;

  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  // 桶文件的 `export { a as b } from "./x"`，以及 Python `__init__.py` 里的
  // `from .impl import foo` 都表现为本文件的一条 import 绑定
  const binding = scope.bindings.get(name);
  if (binding && !binding.isNamespace && binding.targetFileId !== null) {
    const hit = resolveExport(index, binding.targetFileId, binding.imported, seen);
    if (hit !== null) return hit;
  }
  for (const target of scope.stars) {
    const hit = resolveExport(index, target, name, seen);
    if (hit !== null) return hit;
  }
  return null;
}

/** 沿 import / re-export 找到定义 `owner` 的文件，取它的成员 */
function resolveMember(index: RepoIndex, fileId: number, owner: string, member: string, seen: Set<number>): number | null {
  if (seen.has(fileId) || seen.size > 24) return null;
  seen.add(fileId);
  const scope = index.scopes.get(fileId);
  if (!scope) return null;
  const direct = uniqueOf(scope.members.get(`${owner}.${member}`));
  if (direct !== null) return direct;
  const binding = scope.bindings.get(owner);
  if (binding && !binding.isNamespace && binding.targetFileId !== null) {
    const hit = resolveMember(index, binding.targetFileId, binding.imported, member, seen);
    if (hit !== null) return hit;
  }
  for (const target of scope.stars) {
    const hit = resolveMember(index, target, owner, member, seen);
    if (hit !== null) return hit;
  }
  return null;
}

function uniqueOf(ids: number[] | undefined): number | null {
  return ids?.length === 1 ? (ids[0] as number) : null;
}

function fromStars(index: RepoIndex, scope: FileScope, name: string): Resolution {
  const hits = [...new Set(
    scope.stars
      .map((target) => resolveExport(index, target, name, new Set()))
      .filter((id): id is number => id !== null),
  )];
  if (hits.length === 1) return likely(hits[0] as number);
  if (hits.length > 1) {
    return { confidence: "ambiguous", symbolId: hits[0] as number, externalName: null, candidates: hits.slice(0, 16) };
  }
  return UNRESOLVED;
}

/** 同一个包里的候选。Go 编译器保证包内顶层名唯一，多个候选只会来自构建标签。 */
function byPackage(candidates: number[] | undefined, single: "exact" | "likely"): Resolution | null {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) {
    return single === "exact" ? exact(candidates[0] as number) : likely(candidates[0] as number);
  }
  return {
    confidence: "ambiguous",
    symbolId: candidates[0] as number,
    externalName: null,
    candidates: candidates.slice(0, 16),
  };
}

/**
 * 同名方法里，宿主类在本文件可见的那些。
 *
 * 「可见」的判据是类名出现在本文件的类型声明或 import 里。这不是类型推导，
 * 但足以把标准库方法挡在外面：没人会 import 一个叫 Array 的类。
 */
function visibleMethods(
  index: RepoIndex,
  scope: FileScope | undefined,
  callee: string,
): number[] | undefined {
  const all = index.methodsByName.get(callee);
  if (!all || !scope) return undefined;
  const visible = all.filter((id) => {
    const container = index.containerOf.get(id);
    return container !== undefined && scope.visibleTypes.has(container);
  });
  return visible.length > 0 ? visible : undefined;
}

function exact(symbolId: number): Resolution {
  return { confidence: "exact", symbolId, externalName: null, candidates: null };
}

function likely(symbolId: number): Resolution {
  return { confidence: "likely", symbolId, externalName: null, candidates: null };
}

function external(name: string): Resolution {
  return { confidence: "external", symbolId: null, externalName: name, candidates: null };
}

function byName(candidates: number[] | undefined): Resolution {
  if (!candidates || candidates.length === 0) return UNRESOLVED;
  if (candidates.length === 1) return likely(candidates[0] as number);
  // 候选全存下来，界面上可以让人自己挑，而不是替他猜一个
  return {
    confidence: "ambiguous",
    symbolId: candidates[0] as number,
    externalName: null,
    candidates: candidates.slice(0, 16),
  };
}

// ---------------------------------------------------------------------------
// 索引
// ---------------------------------------------------------------------------

interface RepoIndex {
  scopes: Map<number, FileScope>;
  /** 文件 → 导出名 → 符号 id */
  exportsOf: Map<number, Map<string, number>>;
  /** 文件 → 默认导出的符号 id */
  defaultExportOf: Map<number, number>;
  /** 导出的顶层符号，按名字；只给没有模块解析器的语言兜底 */
  exportedByName: Map<string, number[]>;
  /** Go：目录 → 顶层名 → 符号 id（包内可见性不看大小写） */
  topLevelByDir: Map<string, Map<string, number[]>>;
  /** 带容器的符号（方法/字段），按名字 */
  methodsByName: Map<string, number[]>;
  /** 符号 id → 它所属的容器名 */
  containerOf: Map<number, string>;
  /** `容器.名字` → 符号 id，跨文件；Go / Rust 的方法不一定和类型写在同一个文件 */
  membersByKey: Map<string, number[]>;
  /** 文件 → 顶层类型名 → 声明 */
  typesOf: Map<number, Map<string, TypeDecl>>;
  /** Go：目录 → 类型名 → 声明 */
  typesByDir: Map<string, Map<string, TypeDecl>>;
  typeById: Map<number, TypeDecl>;
  /** 类型 → 它 extends / embeds 的目标 */
  parentsOf: Map<number, Array<{ target: string; targetId: number | null }>>;
  /** 接口 / trait → 实现它的类型 */
  implementersOf: Map<number, number[]>;
  symbolInfo: Map<number, { fileId: number; returnType: string | null; params: string | null; signature: string | null }>;
  paramTypeCache: Map<number, Map<string, string>>;
  /** 有文件 import 过的外部名；不在里面的外部名是语言内置（Map、console、len） */
  importedExternals: Set<string>;
}

function addType<K>(table: Map<K, Map<string, TypeDecl>>, key: K, decl: TypeDecl): void {
  let names = table.get(key);
  if (!names) {
    names = new Map();
    table.set(key, names);
  }
  if (!names.has(decl.name)) names.set(decl.name, decl);
}

function buildIndex(db: Db): RepoIndex {
  const scopes = new Map<number, FileScope>();
  const exportsOf = new Map<number, Map<string, number>>();
  const defaultExportOf = new Map<number, number>();
  const exportedByName = new Map<string, number[]>();
  const topLevelByDir = new Map<string, Map<string, number[]>>();
  const methodsByName = new Map<string, number[]>();
  const containerOf = new Map<number, string>();

  const files = db.prepare("SELECT id, language, dir_path AS dir, package_id AS packageId FROM files").all() as Array<{
    id: number;
    language: Language;
    dir: string;
    packageId: number | null;
  }>;
  for (const file of files) {
    scopes.set(file.id, {
      family: resolverFamily(file.language),
      dir: file.dir,
      packageId: file.packageId,
      locals: new Map(),
      members: new Map(),
      bindings: new Map(),
      stars: [],
      visibleTypes: new Set(),
    });
  }
  const scopeOf = (fileId: number): FileScope => scopes.get(fileId) as FileScope;

  const push = (map: Map<string, number[]>, key: string, id: number) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(id);
    else map.set(key, [id]);
  };
  const exportTable = (fileId: number): Map<string, number> => {
    let table = exportsOf.get(fileId);
    if (!table) {
      table = new Map();
      exportsOf.set(fileId, table);
    }
    return table;
  };

  // 只索引可调用的符号。把 interface / type 放进候选池会让
  // `parse(x)` 连到一个同名的类型别名上。
  const symbols = db
    .prepare(
      `SELECT id, file_id AS fileId, name, container, exported, params, return_type AS returnType, signature
       FROM symbols
       WHERE kind IN ('function', 'method', 'class', 'struct', 'constructor', 'enum')`,
    )
    .all() as Array<{
    id: number;
    fileId: number;
    name: string;
    container: string | null;
    exported: number;
    params: string | null;
    returnType: string | null;
    signature: string | null;
  }>;

  const callable = new Set<number>();
  const membersByKey = new Map<string, number[]>();
  const symbolInfo: RepoIndex["symbolInfo"] = new Map();
  for (const sym of symbols) {
    callable.add(sym.id);
    symbolInfo.set(sym.id, {
      fileId: sym.fileId,
      returnType: sym.returnType,
      params: sym.params && sym.params !== "[]" ? sym.params : null,
      signature: sym.signature,
    });
    const scope = scopeOf(sym.fileId);
    if (sym.container === null) {
      push(scope.locals, sym.name, sym.id);
      if (scope.family === "go") {
        let table = topLevelByDir.get(scope.dir);
        if (!table) {
          table = new Map();
          topLevelByDir.set(scope.dir, table);
        }
        push(table, sym.name, sym.id);
      }
      if (sym.exported === 1) {
        const table = exportTable(sym.fileId);
        if (!table.has(sym.name)) table.set(sym.name, sym.id);
        push(exportedByName, sym.name, sym.id);
      }
    } else {
      push(scope.members, `${sym.container}.${sym.name}`, sym.id);
      push(membersByKey, `${sym.container}.${sym.name}`, sym.id);
      push(methodsByName, sym.name, sym.id);
      containerOf.set(sym.id, sym.container);
    }
  }

  // `export { foo as bar }`、`export default foo` 这类导出名和声明名不一致，
  // 或者声明本身没带 export 关键字，只能从导出表补上
  const exportRows = db
    .prepare("SELECT file_id AS fileId, name, kind, symbol_id AS symbolId FROM exports WHERE symbol_id IS NOT NULL")
    .all() as Array<{ fileId: number; name: string; kind: string; symbolId: number }>;
  for (const row of exportRows) {
    if (!callable.has(row.symbolId)) continue;
    if (row.kind === "default") {
      defaultExportOf.set(row.fileId, row.symbolId);
      continue;
    }
    const table = exportTable(row.fileId);
    if (!table.has(row.name)) table.set(row.name, row.symbolId);
  }

  // 类型名单独查一次：上面的候选池只要可调用符号，但判断「这个类在本文件
  // 可见吗」需要连 interface / type 一起算，Go 和 Rust 的方法宿主也在其中。
  const typeDecls = db
    .prepare(
      `SELECT id, file_id AS fileId, name, kind, container, signature FROM symbols
       WHERE kind IN ('class', 'interface', 'struct', 'trait', 'type', 'enum')`,
    )
    .all() as Array<TypeDecl & { container: string | null }>;
  const typesOf = new Map<number, Map<string, TypeDecl>>();
  const typesByDir = new Map<string, Map<string, TypeDecl>>();
  const typeById = new Map<number, TypeDecl>();
  for (const { container, ...decl } of typeDecls) {
    const scope = scopeOf(decl.fileId);
    scope.visibleTypes.add(decl.name);
    typeById.set(decl.id, decl);
    if (container !== null) continue;
    addType(typesOf, decl.fileId, decl);
    if (scope.family === "go") addType(typesByDir, scope.dir, decl);
  }

  // 链接阶段先跑了 linkTypeRelations，target_id 是按全局类型名填的；
  // 父类查找时优先按 import 重新解析 target，这里的 id 只做兜底
  const parentsOf: RepoIndex["parentsOf"] = new Map();
  const implementersOf = new Map<number, number[]>();
  const relations = db
    .prepare(
      `SELECT subject_id AS subjectId, relation, target, target_id AS targetId, confidence
       FROM type_relations WHERE subject_id IS NOT NULL`,
    )
    .all() as Array<{ subjectId: number; relation: string; target: string; targetId: number | null; confidence: string }>;
  for (const rel of relations) {
    if (!typeById.has(rel.subjectId)) continue;
    const targetId = rel.confidence === "ambiguous" ? null : rel.targetId;
    if (rel.relation === "implements") {
      if (targetId === null) continue;
      const bucket = implementersOf.get(targetId);
      if (bucket) bucket.push(rel.subjectId);
      else implementersOf.set(targetId, [rel.subjectId]);
      continue;
    }
    const bucket = parentsOf.get(rel.subjectId);
    if (bucket) bucket.push({ target: rel.target, targetId });
    else parentsOf.set(rel.subjectId, [{ target: rel.target, targetId }]);
  }

  const specs = db
    .prepare(
      `SELECT i.file_id AS fileId, i.target_file_id AS targetFileId, i.target_dir AS targetDir,
              i.external_name AS externalName, s.imported, s.local,
              s.is_namespace AS isNamespace
       FROM import_specifiers s JOIN imports i ON i.id = s.import_id`,
    )
    .all() as Array<{
    fileId: number;
    targetFileId: number | null;
    targetDir: string | null;
    externalName: string | null;
    imported: string;
    local: string;
    isNamespace: number;
  }>;

  for (const spec of specs) {
    const scope = scopeOf(spec.fileId);
    if (spec.imported === "*" && spec.local === "*") {
      if (spec.targetFileId !== null) scope.stars.push(spec.targetFileId);
      continue;
    }
    scope.bindings.set(spec.local, {
      targetFileId: spec.targetFileId,
      targetDir: spec.targetDir,
      externalName: spec.externalName,
      imported: spec.imported,
      isNamespace: spec.isNamespace === 1,
    });
    scope.visibleTypes.add(spec.local);
  }

  return {
    scopes,
    exportsOf,
    defaultExportOf,
    exportedByName,
    topLevelByDir,
    methodsByName,
    containerOf,
    membersByKey,
    typesOf,
    typesByDir,
    typeById,
    parentsOf,
    implementersOf,
    symbolInfo,
    paramTypeCache: new Map(),
    importedExternals: new Set(
      (db.prepare("SELECT DISTINCT external_name AS name FROM imports WHERE external_name IS NOT NULL").all() as Array<{
        name: string;
      }>).map((row) => row.name),
    ),
  };
}
