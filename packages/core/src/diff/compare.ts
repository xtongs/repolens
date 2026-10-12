import { getMeta, type Db } from "../db/database.js";
import type {
  BehaviorChangeDto,
  CallChangeDto,
  ChangeClusterDto,
  ChangeReportDto,
  ClusterReason,
  DependencyChangeDto,
  EntryChangeDto,
  EntryPointKind,
  FileChangeDto,
  FileRole,
  FindingChangeDto,
  FindingKind,
  FindingSeverity,
  IoKind,
  Language,
  SymbolChangeDto,
  SymbolKind,
} from "../types.js";

export interface DiffOptions {
  base: ChangeReportDto["base"];
  head: ChangeReportDto["head"];
}

interface FileRow { id: number; path: string; role: FileRole; language: Language; loc: number; hash: string }

interface SymbolRow {
  id: number; path: string; role: FileRole; name: string; container: string | null; kind: SymbolKind;
  exported: number; signature: string | null; startLine: number; complexity: number; hash: string; shape: string | null;
}

interface EntryRow { id: number; kind: EntryPointKind; label: string; path: string; symbolId: number | null; reachIo: string }

/** 配好对的一次符号变化：新增只有 now，删除只有 prev */
interface SymbolPair { status: SymbolChangeDto["status"]; now: SymbolRow | null; prev: SymbolRow | null }

/** 从入口往下找已变更符号的最大调用深度；再深的影响在审阅时已经说明不了什么 */
const IMPACT_DEPTH = 6;
const STATUS_ORDER = { added: 0, modified: 1, moved: 2, removed: 3 } as const;
/** 新增函数的调用逐个列出来没有意义，列前几个让人知道它在跟谁打交道 */
const MAX_CALLS_LISTED = 12;
/** 依赖 git 历史的结论：基线快照不在 git 里，拿来比只会把它们全报成新增 */
const HISTORY_FINDINGS = new Set<FindingKind>(["coupling", "stale-doc"]);
const IO_ORDER: readonly IoKind[] = ["database", "network", "filesystem", "message-queue", "process"];

/**
 * 两份结构索引之间的差异：文件、符号、模块依赖、外部依赖、体检结论、入口与影响面，
 * 以及每个改动函数的行为变化（新调了谁、开始碰哪类 I/O）和按调用关系归好的改动单元。
 *
 * 全部来自解析事实，不经过模型——审 AI 写的代码时，最需要的正是一份不会被
 * 「解释」掉的客观变化清单：它新加了哪条依赖、动了哪些对外接口、哪些入口会走到改过的代码。
 */
export function diffIndexes(base: Db, head: Db, options: DiffOptions): ChangeReportDto {
  const files = diffFiles(loadFiles(base), loadFiles(head));
  const pairs = pairSymbols(base, head, files);
  const symbols = describeSymbols(base, head, pairs);
  const behavior = diffBehavior(base, head, pairs);
  const entries = diffEntries(base, head, symbols);
  return {
    base: options.base,
    head: options.head,
    headIndexedAt: getMeta(head, "scanned_at"),
    generatedAt: new Date().toISOString(),
    files,
    symbols,
    dependencies: diffDependencies(base, head),
    externals: diffExternals(base, head),
    findings: diffFindings(base, head),
    entries,
    behavior,
    clusters: clusterChanges(head, symbols, behavior, entries),
  };
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

function loadFiles(db: Db): Map<string, FileRow> {
  const rows = db.prepare("SELECT id, path, role, language, loc, hash FROM files").all() as FileRow[];
  return new Map(rows.map((row) => [row.path, row]));
}

function diffFiles(before: Map<string, FileRow>, after: Map<string, FileRow>): FileChangeDto[] {
  const added = [...after.values()].filter((file) => !before.has(file.path));
  const removed = [...before.values()].filter((file) => !after.has(file.path));
  const out: FileChangeDto[] = [];

  // 内容完全相同、只换了路径的算移动：否则一次目录重组会被报成几十个删除加几十个新增
  const removedByHash = new Map<string, FileRow[]>();
  for (const file of removed) {
    const bucket = removedByHash.get(file.hash);
    if (bucket) bucket.push(file); else removedByHash.set(file.hash, [file]);
  }
  const moved = new Set<string>();
  for (const file of added) {
    const origin = removedByHash.get(file.hash)?.shift();
    if (!origin) continue;
    moved.add(file.path).add(origin.path);
    out.push(fileChange("moved", file, origin, origin.path));
  }

  for (const file of added) if (!moved.has(file.path)) out.push(fileChange("added", file, null));
  for (const file of removed) if (!moved.has(file.path)) out.push(fileChange("removed", null, file));
  for (const file of after.values()) {
    const old = before.get(file.path);
    if (old && old.hash !== file.hash) out.push(fileChange("modified", file, old));
  }
  return out.sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.path.localeCompare(b.path));
}

function fileChange(
  status: FileChangeDto["status"], now: FileRow | null, old: FileRow | null, from?: string,
): FileChangeDto {
  const ref = (now ?? old) as FileRow;
  return {
    status, path: ref.path, ...(from ? { from } : {}), id: now ? `file:${now.id}` : null,
    role: ref.role, language: ref.language, loc: now?.loc ?? 0, locBefore: old?.loc ?? 0,
  };
}

// ---------------------------------------------------------------------------
// 符号
// ---------------------------------------------------------------------------

function pairSymbols(base: Db, head: Db, files: readonly FileChangeDto[]): SymbolPair[] {
  // 内容没变的文件里符号不可能变；移动的文件内容相同，也不必逐个比
  const headPaths = files.filter((f) => f.status === "added" || f.status === "modified").map((f) => f.path);
  const basePaths = files.filter((f) => f.status === "removed" || f.status === "modified").map((f) => f.path);
  const before = groupByKey(loadSymbols(base, basePaths));
  const after = groupByKey(loadSymbols(head, headPaths));

  const out: SymbolPair[] = [];
  for (const [key, now] of after) {
    const old = before.get(key) ?? [];
    // 同一文件里同名同类的符号（重载、同名闭包）按出现顺序配对
    now.forEach((symbol, i) => {
      const prev = old[i];
      if (!prev) out.push({ status: "added", now: symbol, prev: null });
      else if (prev.hash !== symbol.hash) out.push({ status: "modified", now: symbol, prev });
    });
    for (const prev of old.slice(now.length)) out.push({ status: "removed", now: null, prev });
  }
  for (const [key, old] of before) {
    if (after.has(key)) continue;
    for (const prev of old) out.push({ status: "removed", now: null, prev });
  }
  return out;
}

function describeSymbols(base: Db, head: Db, pairs: readonly SymbolPair[]): SymbolChangeDto[] {
  const callersIn = (db: Db) => db.prepare(
    `SELECT COUNT(DISTINCT src_id) AS n FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND dst_id = ?`,
  );
  const headCallers = callersIn(head);
  const baseCallers = callersIn(base);
  const count = (stmt: ReturnType<typeof callersIn>, id: number) => (stmt.get(id) as { n: number }).n;
  const testsOf = head.prepare("SELECT tests FROM test_coverage WHERE symbol_id = ?");

  const out = pairs.map((pair) => {
    const callers = pair.now ? count(headCallers, pair.now.id) : count(baseCallers, pair.prev!.id);
    const change = symbolChange(pair.status, pair.now, pair.prev, callers);
    if (pair.now) change.tests = (testsOf.get(pair.now.id) as { tests: number } | undefined)?.tests ?? 0;
    else change.tests = null;
    return change;
  });
  const roleRank = (role: FileRole) => (role === "source" ? 0 : role === "test" ? 2 : 1);
  return out.sort((a, b) =>
    roleRank(a.role) - roleRank(b.role) || a.path.localeCompare(b.path) || a.line - b.line);
}

function loadSymbols(db: Db, paths: readonly string[]): SymbolRow[] {
  if (paths.length === 0) return [];
  const stmt = db.prepare(
    `SELECT s.id, f.path, f.role, s.name, s.container, s.kind, s.exported, s.signature,
            s.start_line AS startLine, s.complexity, s.hash, s.shape
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? ORDER BY s.start_line`,
  );
  return paths.flatMap((path) => stmt.all(path) as SymbolRow[]);
}

function groupByKey(rows: readonly SymbolRow[]): Map<string, SymbolRow[]> {
  const out = new Map<string, SymbolRow[]>();
  for (const row of rows) {
    const key = `${row.path}\u0000${row.container ?? ""}\u0000${row.name}\u0000${row.kind}`;
    const bucket = out.get(key);
    if (bucket) bucket.push(row); else out.set(key, [row]);
  }
  return out;
}

function symbolChange(
  status: SymbolChangeDto["status"], now: SymbolRow | null, old: SymbolRow | null, callers: number,
): SymbolChangeDto {
  const ref = (now ?? old) as SymbolRow;
  return {
    status,
    id: now ? `sym:${now.id}` : null,
    name: ref.name,
    container: ref.container,
    kind: ref.kind,
    path: ref.path,
    line: ref.startLine,
    exported: ref.exported === 1,
    role: ref.role,
    complexity: ref.complexity,
    complexityBefore: old?.complexity ?? null,
    signature: now?.signature ?? null,
    signatureBefore: old?.signature ?? null,
    shapeChanged: !now || !old || now.shape === null || now.shape !== old.shape,
    callers,
  };
}

// ---------------------------------------------------------------------------
// 行为
// ---------------------------------------------------------------------------

interface OutgoingCall extends CallChangeDto { key: string }

/**
 * 每个新增、修改的源码函数：新调了谁、不再调谁、开始或不再直接访问哪类 I/O。
 * 只看能落到仓库里的调用和第三方库；`JSON.parse`、`Map.get` 这类语言内置、
 * 推不出去向的调用，改来改去说明不了行为，列出来只是噪音。
 */
function diffBehavior(base: Db, head: Db, pairs: readonly SymbolPair[]): BehaviorChangeDto[] {
  const baseCalls = outgoingCalls(base);
  const headCalls = outgoingCalls(head);
  const out: BehaviorChangeDto[] = [];
  for (const pair of pairs) {
    const now = pair.now;
    if (!now || now.role !== "source" || (now.kind !== "function" && now.kind !== "method")) continue;
    const after = headCalls(now.id);
    const before = pair.prev ? baseCalls(pair.prev.id) : { calls: new Map<string, OutgoingCall>(), io: new Set<IoKind>() };
    const callsAdded = [...after.calls].filter(([key]) => !before.calls.has(key)).map(([, call]) => call);
    const callsRemoved = [...before.calls].filter(([key]) => !after.calls.has(key)).map(([, call]) => call);
    const ioAdded = IO_ORDER.filter((kind) => after.io.has(kind) && !before.io.has(kind));
    const ioRemoved = IO_ORDER.filter((kind) => before.io.has(kind) && !after.io.has(kind));
    if (callsAdded.length + callsRemoved.length + ioAdded.length + ioRemoved.length === 0) continue;
    const strip = ({ key: _key, ...call }: OutgoingCall): CallChangeDto => call;
    out.push({
      id: `sym:${now.id}`,
      name: now.container ? `${now.container}.${now.name}` : now.name,
      path: now.path,
      line: now.startLine,
      status: pair.status === "added" ? "added" : "modified",
      callsAdded: callsAdded.slice(0, MAX_CALLS_LISTED).map(strip),
      callsRemoved: callsRemoved.slice(0, MAX_CALLS_LISTED).map(strip),
      ioAdded,
      ioRemoved,
    });
  }
  // I/O 变化最该先看，其次是调用变化多的
  const weight = (b: BehaviorChangeDto) => (b.ioAdded.length + b.ioRemoved.length) * 100 + b.callsAdded.length + b.callsRemoved.length;
  return out.sort((a, b) => weight(b) - weight(a) || a.path.localeCompare(b.path) || a.line - b.line);
}

/** 按「被调方是谁」去重的出向调用：仓库内按目标的路径和全名，第三方按库名和方法名 */
function outgoingCalls(db: Db): (symbolId: number) => { calls: Map<string, OutgoingCall>; io: Set<IoKind> } {
  const libraries = new Set((db.prepare(
    "SELECT DISTINCT external_name AS name FROM imports WHERE external_name IS NOT NULL",
  ).all() as Array<{ name: string }>).map((row) => row.name));
  const stmt = db.prepare(
    `SELECT c.callee_name AS callee, c.resolution, c.target_name AS external, c.io_kind AS io,
            c.receiver, c.receiver_type AS receiverType,
            c.target_symbol_id AS targetId, t.name AS targetName, t.container AS targetContainer, tf.path AS targetPath
     FROM call_sites c
     LEFT JOIN symbols t ON t.id = c.target_symbol_id
     LEFT JOIN files tf ON tf.id = t.file_id
     WHERE c.caller_symbol_id = ?`,
  );
  return (symbolId) => {
    const calls = new Map<string, OutgoingCall>();
    const io = new Set<IoKind>();
    for (const row of stmt.all(symbolId) as Array<{
      callee: string; resolution: string; external: string | null; io: IoKind | null;
      receiver: string | null; receiverType: string | null;
      targetId: number | null; targetName: string | null; targetContainer: string | null; targetPath: string | null;
    }>) {
      // `readFileSync(p).toUpperCase()` 的 toUpperCase 只是借了上游库的名字，算进去就成了「新调了 node:fs」
      const derived = (row.receiver ?? "").includes("(") || /^[RAM]:/.test(row.receiverType ?? "");
      if (row.io) io.add(row.io);
      if ((row.resolution === "exact" || row.resolution === "likely") && row.targetName !== null && row.targetPath !== null) {
        const name = row.targetContainer ? `${row.targetContainer}.${row.targetName}` : row.targetName;
        const key = `sym:${row.targetPath}#${name}`;
        if (!calls.has(key)) calls.set(key, { key, name, target: `sym:${row.targetId}`, external: null });
      } else if (row.resolution === "ambiguous") {
        const key = `amb:${row.callee}`;
        if (!calls.has(key)) calls.set(key, { key, name: row.callee, target: null, external: null });
      } else if (row.resolution === "external" && row.external !== null && libraries.has(row.external) && !derived) {
        const key = `ext:${row.external}:${row.callee}`;
        if (!calls.has(key)) calls.set(key, { key, name: row.callee, target: null, external: row.external });
      }
    }
    return { calls, io };
  };
}

// ---------------------------------------------------------------------------
// 依赖
// ---------------------------------------------------------------------------

function diffDependencies(base: Db, head: Db): DependencyChangeDto[] {
  const load = (db: Db) => {
    const rows = db.prepare(
      `SELECT level, type, src, dst, SUM(count) AS count FROM rollup_edges
       WHERE level IN ('package', 'directory') AND type IN ('imports', 'references', 'http') AND src != dst
       GROUP BY level, type, src, dst`,
    ).all() as Array<{ level: "package" | "directory"; type: DependencyChangeDto["type"]; src: string; dst: string; count: number }>;
    return new Map(rows.map((row) => [`${row.level}\u0000${row.type}\u0000${row.src}\u0000${row.dst}`, row]));
  };
  const before = load(base);
  const after = load(head);
  const out: DependencyChangeDto[] = [];
  for (const [key, row] of after) {
    if (!before.has(key)) out.push({ status: "added", level: row.level, source: row.src, target: row.dst, type: row.type, count: row.count });
  }
  for (const [key, row] of before) {
    if (!after.has(key)) out.push({ status: "removed", level: row.level, source: row.src, target: row.dst, type: row.type, count: row.count });
  }
  return out.sort((a, b) =>
    (a.level === b.level ? 0 : a.level === "package" ? -1 : 1) ||
    (a.status === b.status ? 0 : a.status === "added" ? -1 : 1) ||
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target));
}

function diffExternals(base: Db, head: Db): ChangeReportDto["externals"] {
  // 测试和配置里多引一个库不影响产物，只看会进运行时的代码
  const load = (db: Db) => new Set((db.prepare(
    `SELECT DISTINCT i.external_name AS name FROM imports i JOIN files f ON f.id = i.file_id
     WHERE i.confidence = 'external' AND i.external_name IS NOT NULL AND f.role = 'source'`,
  ).all() as Array<{ name: string }>).map((row) => row.name));
  const before = load(base);
  const after = load(head);
  return {
    added: [...after].filter((name) => !before.has(name)).sort(),
    removed: [...before].filter((name) => !after.has(name)).sort(),
  };
}

// ---------------------------------------------------------------------------
// 体检
// ---------------------------------------------------------------------------

function diffFindings(base: Db, head: Db): FindingChangeDto[] {
  // 同一条问题会挂在它涉及的每个作用域上，按分组键收成一条
  const load = (db: Db) => {
    const rows = db.prepare(
      `SELECT kind, severity, title, detail, scope_key AS scopeKey, path, group_key AS groupKey
       FROM findings ORDER BY id`,
    ).all() as Array<{ kind: FindingKind; severity: FindingSeverity; title: string; detail: string; scopeKey: string; path: string; groupKey: string }>;
    const out = new Map<string, (typeof rows)[number]>();
    for (const row of rows) {
      if (HISTORY_FINDINGS.has(row.kind)) continue;
      const key = row.groupKey || `${row.kind}:${row.scopeKey}:${row.title}`;
      if (!out.has(key)) out.set(key, row);
    }
    return out;
  };
  const before = load(base);
  const after = load(head);
  const pick = (status: FindingChangeDto["status"], row: NonNullable<ReturnType<typeof after.get>>): FindingChangeDto => ({
    status, kind: row.kind, severity: row.severity, title: row.title, detail: row.detail, scopeKey: row.scopeKey, path: row.path,
  });
  return [
    ...[...after].filter(([key]) => !before.has(key)).map(([, row]) => pick("added", row)),
    ...[...before].filter(([key]) => !after.has(key)).map(([, row]) => pick("resolved", row)),
  ];
}

// ---------------------------------------------------------------------------
// 入口与影响面
// ---------------------------------------------------------------------------

function diffEntries(base: Db, head: Db, symbols: readonly SymbolChangeDto[]): EntryChangeDto[] {
  const before = loadEntries(base);
  const after = loadEntries(head);
  const out: EntryChangeDto[] = [];
  const symbolOf = (entry: EntryRow) => (entry.symbolId === null ? null : `sym:${entry.symbolId}`);
  const ioOf = (entry: EntryRow) => new Set(entry.reachIo === "" ? [] : (entry.reachIo.split(",") as IoKind[]));
  for (const [key, entry] of after) {
    if (before.has(key)) continue;
    const io = ioOf(entry);
    out.push({
      status: "added", id: `entry:${entry.id}`, symbolId: symbolOf(entry), kind: entry.kind, label: entry.label, path: entry.path, via: [],
      ...(io.size > 0 ? { ioAdded: IO_ORDER.filter((kind) => io.has(kind)) } : {}),
    });
  }
  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    out.push({ status: "removed", id: null, symbolId: null, kind: entry.kind, label: entry.label, path: entry.path, via: [] });
  }

  const reached = reachFromChanges(head, symbols);
  for (const [key, entry] of after) {
    const old = before.get(key);
    if (!old || entry.symbolId === null) continue;
    const via = reached.get(entry.symbolId) ?? [];
    const now = ioOf(entry);
    const was = ioOf(old);
    const ioAdded = IO_ORDER.filter((kind) => now.has(kind) && !was.has(kind));
    const ioRemoved = IO_ORDER.filter((kind) => was.has(kind) && !now.has(kind));
    if (via.length === 0 && ioAdded.length === 0 && ioRemoved.length === 0) continue;
    out.push({
      status: "affected", id: `entry:${entry.id}`, symbolId: symbolOf(entry), kind: entry.kind, label: entry.label, path: entry.path,
      via: via.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)).slice(0, 8),
      ...(ioAdded.length > 0 ? { ioAdded } : {}),
      ...(ioRemoved.length > 0 ? { ioRemoved } : {}),
    });
  }
  const kindRank: Record<EntryPointKind, number> = { http: 0, cli: 1, main: 2, "public-api": 3, test: 4 };
  const statusRank = { added: 0, removed: 1, affected: 2 } as const;
  // 同一类里新碰到 I/O 的入口排前面：那是行为面的变化
  const ioRank = (entry: EntryChangeDto) => ((entry.ioAdded?.length ?? 0) > 0 ? 0 : 1);
  return out.sort((a, b) =>
    statusRank[a.status] - statusRank[b.status] || ioRank(a) - ioRank(b) || kindRank[a.kind] - kindRank[b.kind] ||
    (a.via[0]?.depth ?? 0) - (b.via[0]?.depth ?? 0) || a.label.localeCompare(b.label));
}

function loadEntries(db: Db): Map<string, EntryRow> {
  // 测试入口成百上千，列出来只会淹没真正的业务入口
  const rows = db.prepare(
    `SELECT e.id, e.kind, e.label, f.path, e.symbol_id AS symbolId, e.reach_io AS reachIo
     FROM entry_points e JOIN files f ON f.id = e.file_id WHERE e.kind != 'test' ORDER BY e.id`,
  ).all() as EntryRow[];
  const out = new Map<string, EntryRow>();
  for (const row of rows) {
    // 路由和命令靠标签就能认出来；公共 API 同名的可能在不同文件
    const key = row.kind === "http" || row.kind === "cli" ? `${row.kind}\u0000${row.label}` : `${row.kind}\u0000${row.label}\u0000${row.path}`;
    if (!out.has(key)) out.set(key, row);
  }
  return out;
}

/**
 * 从每个新增/修改的符号沿调用边反向扩散，得到「谁能走到这处改动」。
 * 结果按调用者 id 索引：值是它能走到的已变更符号及距离。
 */
function reachFromChanges(head: Db, symbols: readonly SymbolChangeDto[]): Map<number, Array<{ id: string; name: string; depth: number }>> {
  const callers = callerIndex(head);
  const out = new Map<number, Array<{ id: string; name: string; depth: number }>>();
  for (const change of symbols) {
    if (change.id === null || change.role !== "source") continue;
    const start = Number(change.id.slice(4));
    const seen = new Set([start]);
    let frontier = [start];
    for (let depth = 0; depth <= IMPACT_DEPTH && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        const list = out.get(id);
        const hit = { id: change.id, name: change.container ? `${change.container}.${change.name}` : change.name, depth };
        if (list) list.push(hit); else out.set(id, [hit]);
        for (const caller of callers.get(id) ?? []) {
          if (seen.has(caller)) continue;
          seen.add(caller);
          next.push(caller);
        }
      }
      frontier = next;
    }
  }
  return out;
}

function callerIndex(db: Db): Map<number, number[]> {
  const callers = new Map<number, number[]>();
  const rows = db.prepare(
    `SELECT src_id AS "from", dst_id AS "to" FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND confidence IN ('exact', 'likely')`,
  ).all() as Array<{ from: number; to: number }>;
  for (const row of rows) {
    const bucket = callers.get(row.to);
    if (bucket) bucket.push(row.from); else callers.set(row.to, [row.from]);
  }
  return callers;
}

// ---------------------------------------------------------------------------
// 改动单元
// ---------------------------------------------------------------------------

/** 被这么多个改过的函数调用的改动，是大家都在用的工具：不从它这里把各件事连成一团 */
const HUB_CALLERS = 4;
/** 一组最多沿调用往下认领这么多层、这么多个；再多就不是一次能审完的一件事，剩下的各自成组 */
const CLUSTER_DEPTH = 3;
const CLUSTER_SIZE = 20;
/** 一个函数新增的调用再多，对风险的贡献也封顶：新写的大函数不该把别的风险全淹掉 */
const CALLS_RISK_CAP = 3;

/**
 * 把改动的源码符号分成几件事。从没被其他改动调用的上游函数出发，沿调用往下认领改过的函数：
 * 它调了谁、谁又改了，多半是同一件事。被很多改动调用的工具函数自成一组，不当桥把不相干的事连起来；
 * 类型、常量这些没有调用关系的，同一个文件里的归成一组。每组按风险排序——导出接口、签名变化、
 * 新 I/O、新调用、复杂度上升、没有测试，以及走得到它的入口数——审的时候从最上面那组开始。
 */
export function clusterChanges(
  head: Db, symbols: readonly SymbolChangeDto[], behavior: readonly BehaviorChangeDto[], entries: readonly EntryChangeDto[],
): ChangeClusterDto[] {
  const changed = symbols.filter((s) => s.id !== null && s.role === "source" && s.status !== "removed");
  if (changed.length === 0) return [];
  const isFunction = (s: SymbolChangeDto) => s.kind === "function" || s.kind === "method";
  const functions = changed.filter(isFunction);
  const index = new Map(functions.map((s, i) => [Number(s.id!.slice(4)), i]));

  const callees = functions.map(() => [] as number[]);
  const callers = functions.map(() => 0);
  const stmt = head.prepare(
    `SELECT DISTINCT dst_id AS dst FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND confidence IN ('exact', 'likely') AND src_id = ?`,
  );
  for (const [i, s] of functions.entries()) {
    for (const row of stmt.all(Number(s.id!.slice(4))) as Array<{ dst: number }>) {
      const j = index.get(row.dst);
      if (j === undefined || j === i) continue;
      callees[i]!.push(j);
      callers[j]!++;
    }
  }
  const hub = (i: number) => callers[i]! >= HUB_CALLERS;

  // 上游先认领：没被别的改动调用的在前，同样是上游的按导出、复杂度排
  const order = functions.map((_, i) => i).sort((a, b) =>
    Number(callers[a]! > 0) - Number(callers[b]! > 0) ||
    Number(functions[b]!.exported) - Number(functions[a]!.exported) ||
    functions[b]!.complexity - functions[a]!.complexity);
  const owner = functions.map(() => -1);
  const groups: SymbolChangeDto[][] = [];
  for (const root of order) {
    if (owner[root] !== -1) continue;
    const group = groups.length;
    const members: SymbolChangeDto[] = [];
    const queue: Array<{ i: number; depth: number }> = [{ i: root, depth: 0 }];
    owner[root] = group;
    let claimed = 1;
    while (queue.length > 0) {
      const { i, depth } = queue.shift()!;
      members.push(functions[i]!);
      if (depth >= CLUSTER_DEPTH) continue;
      for (const j of callees[i]!) {
        if (owner[j] !== -1 || hub(j) || claimed >= CLUSTER_SIZE) continue;
        owner[j] = group;
        claimed++;
        queue.push({ i: j, depth: depth + 1 });
      }
    }
    groups.push(members);
  }

  const byFile = new Map<string, SymbolChangeDto[]>();
  for (const s of changed) {
    if (isFunction(s)) continue;
    const bucket = byFile.get(s.path);
    if (bucket) bucket.push(s); else byFile.set(s.path, [s]);
  }
  const declarationGroups = [...byFile.entries()];

  const behaviorById = new Map(behavior.flatMap((b) => (b.id ? [[b.id, b] as const] : [])));
  const describe = (items: SymbolChangeDto[], label: string, id: string): ChangeClusterDto => {
    const memberIds = new Set(items.map((s) => s.id!));
    const reasons = new Map<ClusterReason, number>();
    const bump = (kind: ClusterReason, n = 1) => {
      if (n > 0) reasons.set(kind, (reasons.get(kind) ?? 0) + n);
    };
    let risk = 0;
    for (const s of items) {
      const b = behaviorById.get(s.id!);
      if (s.exported) { bump("exported"); risk += 3; }
      if (s.status === "modified" && s.signature !== s.signatureBefore) { bump("signature"); risk += 2; }
      if (b) {
        bump("io", b.ioAdded.length);
        bump("calls", b.callsAdded.length);
        risk += b.ioAdded.length * 4 + Math.min(CALLS_RISK_CAP, b.callsAdded.length);
      }
      if (s.complexityBefore !== null && s.complexity - s.complexityBefore >= 5) { bump("complexity"); risk += 2; }
      if (isFunction(s) && s.tests === 0 && s.shapeChanged) { bump("untested"); risk += 2; }
      risk += 1;
    }
    const touching = entries.filter((e) => e.via.some((v) => memberIds.has(v.id)) || (e.symbolId !== null && memberIds.has(e.symbolId)));
    bump("entries", touching.length);
    risk += touching.length;
    return {
      id, label, members: items.map((s) => s.id!), entries: touching.length, risk,
      reasons: [...reasons].map(([kind, count]) => ({ kind, count })),
    };
  };

  const out = [
    // 每组第一个就是认领它的那个上游函数
    ...groups.map((items) => describe(items, qualifiedName(items[0]!), `cluster:${items[0]!.id}`)),
    ...declarationGroups.map(([path, items]) =>
      describe(items, items.length === 1 ? qualifiedName(items[0]!) : (path.split("/").at(-1) ?? path), `cluster:${path}`)),
  ];
  return out.sort((a, b) => b.risk - a.risk || b.members.length - a.members.length || a.label.localeCompare(b.label));
}

function qualifiedName(s: SymbolChangeDto): string {
  return s.container ? `${s.container}.${s.name}` : s.name;
}
