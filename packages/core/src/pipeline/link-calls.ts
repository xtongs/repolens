import type { Db } from "../db/database.js";
import type { EdgeRow } from "../db/writer.js";
import type { Confidence } from "../types.js";

/**
 * 调用点 → 符号级调用边。
 *
 * 这是整个项目里最容易产生「看起来很确定的错边」的地方，所以每条边都必须
 * 带上置信度，而且判定顺序是从「语言语义能证明的」逐级降到「靠名字猜的」：
 *
 *   exact      同文件定义 / this.x 命中同一个类 / import 链能一路走到定义
 *   likely     全局唯一的同名候选（自由函数只认导出的，方法只认方法）
 *   ambiguous  同名候选不止一个，候选 id 一并存下来交给界面
 *   external   调用目标来自第三方或标准库
 *   unresolved 什么都没匹配上，不产生边
 *
 * unresolved 不落边是有意的：`console.log` 这类占了调用点的大头，
 * 把它们画进图里只会淹没真正的结构。统计数字仍然会报出来。
 */

export interface CallLinkStats {
  callSites: number;
  edges: number;
  byConfidence: Record<Confidence, number>;
}

/** 这些名字下的方法调用一律当外部，避免仓库里恰好有同名函数时误连 */
const BUILTIN_RECEIVERS = new Set([
  "console",
  "Math",
  "JSON",
  "Object",
  "Array",
  "String",
  "Number",
  "Boolean",
  "Promise",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Symbol",
  "Error",
  "Reflect",
  "Proxy",
  "BigInt",
  "globalThis",
  "process",
  "Buffer",
  "self",
  "window",
  "document",
]);

interface Binding {
  /** import 解析到的目标文件；Go 的包级 import 没有文件粒度，为 null */
  targetFileId: number | null;
  externalName: string | null;
  /** 在目标模块里的原名，与本地别名区分 */
  imported: string;
  isNamespace: boolean;
}

interface FileScope {
  /** 本文件顶层定义：名字 → 符号 id */
  locals: Map<string, number[]>;
  /** 本文件的成员：`容器.名字` → 符号 id */
  members: Map<string, number[]>;
  /** import 的本地名 → 绑定 */
  bindings: Map<string, Binding>;
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

  const rows = db
    .prepare(
      `SELECT c.file_id AS fileId, c.caller_symbol_id AS callerId, c.callee_name AS callee,
              c.receiver, c.callee_path AS calleePath, c.call_kind AS callKind, c.line
       FROM call_sites c`,
    )
    .all() as Array<{
    fileId: number;
    callerId: number | null;
    callee: string;
    receiver: string | null;
    calleePath: string | null;
    callKind: string;
    line: number;
  }>;

  for (const row of rows) {
    stats.callSites++;
    const scope = index.scopes.get(row.fileId);
    const target = resolveCall(index, scope, row);
    stats.byConfidence[target.confidence]++;
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

function resolveCall(
  index: RepoIndex,
  scope: FileScope | undefined,
  row: {
    callerId: number | null;
    callee: string;
    receiver: string | null;
    calleePath: string | null;
    callKind: string;
  },
): Resolution {
  const isMethod = row.receiver !== null && row.receiver.length > 0;

  if (isMethod) {
    const receiver = row.receiver as string;

    // this.foo() —— 唯一能靠语法确定接收者类型的方法调用
    if (receiver === "this" || receiver === "self") {
      const container = row.callerId !== null ? index.containerOf.get(row.callerId) : undefined;
      if (container && scope) {
        const hit = scope.members.get(`${container}.${row.callee}`);
        if (hit && hit.length > 0) return exact(hit[0] as number);
      }
      // 落在父类身上的调用没法靠语法确定，交给下面的全局方法名匹配
    }

    const head = receiver.split(".")[0] as string;
    if (BUILTIN_RECEIVERS.has(head)) {
      return { confidence: "external", symbolId: null, externalName: head, candidates: null };
    }

    // 命名空间导入：import * as fs → fs.readFile()
    const binding = scope?.bindings.get(head);
    if (binding?.isNamespace) {
      if (binding.externalName !== null) {
        return {
          confidence: "external",
          symbolId: null,
          externalName: binding.externalName,
          candidates: null,
        };
      }
      if (binding.targetFileId !== null) {
        const hit = index.exportsOf.get(binding.targetFileId)?.get(row.callee);
        if (hit !== undefined) return exact(hit);
      }
    }

    // 接收者是个普通变量，类型未知。候选池要同时满足两个条件：是方法，
    // 且宿主类在本文件可见（本地定义或 import 进来）。少了后一条，
    // `arr.push(x)` 会连到仓库里任意一个恰好叫 push 的用户方法上——
    // 在 pi 上这一类假边有一千多条，而它们全都指向毫不相干的类。
    return byName(visibleMethods(index, scope, row.callee));
  }

  // ---- 普通函数调用 ----

  if (scope) {
    const local = scope.locals.get(row.callee);
    if (local && local.length === 1) return exact(local[0] as number);
    if (local && local.length > 1) {
      return { confidence: "ambiguous", symbolId: local[0] as number, externalName: null, candidates: local };
    }

    const binding = scope.bindings.get(row.callee);
    if (binding) {
      if (binding.externalName !== null) {
        return {
          confidence: "external",
          symbolId: null,
          externalName: binding.externalName,
          candidates: null,
        };
      }
      if (binding.targetFileId !== null) {
        const hit = index.exportsOf.get(binding.targetFileId)?.get(binding.imported);
        if (hit !== undefined) return exact(hit);
        // import 指到了文件但找不到这个导出：多半是 `export * from`
        // 的转发链，降级成全局匹配而不是硬说它 exact
      }
    }
  }

  return byName(index.exportedByName.get(row.callee));
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

function byName(candidates: number[] | undefined): Resolution {
  if (!candidates || candidates.length === 0) return UNRESOLVED;
  if (candidates.length === 1) {
    return { confidence: "likely", symbolId: candidates[0] as number, externalName: null, candidates: null };
  }
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
  /** 导出的顶层符号，按名字 */
  exportedByName: Map<string, number[]>;
  /** 带容器的符号（方法/字段），按名字 */
  methodsByName: Map<string, number[]>;
  /** 符号 id → 它所属的容器名 */
  containerOf: Map<number, string>;
}

function buildIndex(db: Db): RepoIndex {
  const scopes = new Map<number, FileScope>();
  const exportsOf = new Map<number, Map<string, number>>();
  const exportedByName = new Map<string, number[]>();
  const methodsByName = new Map<string, number[]>();
  const containerOf = new Map<number, string>();

  const scopeOf = (fileId: number): FileScope => {
    let scope = scopes.get(fileId);
    if (!scope) {
      scope = {
        locals: new Map(),
        members: new Map(),
        bindings: new Map(),
        visibleTypes: new Set(),
      };
      scopes.set(fileId, scope);
    }
    return scope;
  };

  const push = (map: Map<string, number[]>, key: string, id: number) => {
    const bucket = map.get(key);
    if (bucket) bucket.push(id);
    else map.set(key, [id]);
  };

  // 只索引可调用的符号。把 interface / type 放进候选池会让
  // `parse(x)` 连到一个同名的类型别名上。
  const symbols = db
    .prepare(
      `SELECT id, file_id AS fileId, name, container, exported
       FROM symbols
       WHERE kind IN ('function', 'method', 'class', 'struct', 'constructor', 'enum')`,
    )
    .all() as Array<{
    id: number;
    fileId: number;
    name: string;
    container: string | null;
    exported: number;
  }>;

  for (const sym of symbols) {
    const scope = scopeOf(sym.fileId);
    if (sym.container === null) {
      push(scope.locals, sym.name, sym.id);
      if (sym.exported === 1) {
        let table = exportsOf.get(sym.fileId);
        if (!table) {
          table = new Map();
          exportsOf.set(sym.fileId, table);
        }
        if (!table.has(sym.name)) table.set(sym.name, sym.id);
        push(exportedByName, sym.name, sym.id);
      }
    } else {
      push(scope.members, `${sym.container}.${sym.name}`, sym.id);
      push(methodsByName, sym.name, sym.id);
      containerOf.set(sym.id, sym.container);
    }
  }

  // 类型名单独查一次：上面的候选池只要可调用符号，但判断「这个类在本文件
  // 可见吗」需要连 interface / type 一起算，Go 和 Rust 的方法宿主也在其中。
  const typeDecls = db
    .prepare(
      `SELECT file_id AS fileId, name FROM symbols
       WHERE kind IN ('class', 'interface', 'struct', 'trait', 'type', 'enum')`,
    )
    .all() as Array<{ fileId: number; name: string }>;
  for (const decl of typeDecls) scopeOf(decl.fileId).visibleTypes.add(decl.name);

  const specs = db
    .prepare(
      `SELECT i.file_id AS fileId, i.target_file_id AS targetFileId,
              i.external_name AS externalName, s.imported, s.local,
              s.is_namespace AS isNamespace
       FROM import_specifiers s JOIN imports i ON i.id = s.import_id`,
    )
    .all() as Array<{
    fileId: number;
    targetFileId: number | null;
    externalName: string | null;
    imported: string;
    local: string;
    isNamespace: number;
  }>;

  for (const spec of specs) {
    const scope = scopeOf(spec.fileId);
    scope.bindings.set(spec.local, {
      targetFileId: spec.targetFileId,
      externalName: spec.externalName,
      imported: spec.imported,
      isNamespace: spec.isNamespace === 1,
    });
    scope.visibleTypes.add(spec.local);
  }

  return { scopes, exportsOf, exportedByName, methodsByName, containerOf };
}
