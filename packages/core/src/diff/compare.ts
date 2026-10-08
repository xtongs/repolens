import { getMeta, type Db } from "../db/database.js";
import type {
  ChangeReportDto,
  DependencyChangeDto,
  EntryChangeDto,
  EntryPointKind,
  FileChangeDto,
  FileRole,
  FindingChangeDto,
  FindingKind,
  FindingSeverity,
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

interface EntryRow { id: number; kind: EntryPointKind; label: string; path: string; symbolId: number | null }

/** 从入口往下找已变更符号的最大调用深度；再深的影响在审阅时已经说明不了什么 */
const IMPACT_DEPTH = 6;
const STATUS_ORDER = { added: 0, modified: 1, moved: 2, removed: 3 } as const;

/**
 * 两份结构索引之间的差异：文件、符号、模块依赖、外部依赖、体检结论、入口与影响面。
 *
 * 全部来自解析事实，不经过模型——审 AI 写的代码时，最需要的正是一份不会被
 * 「解释」掉的客观变化清单：它新加了哪条依赖、动了哪些对外接口、哪些入口会走到改过的代码。
 */
export function diffIndexes(base: Db, head: Db, options: DiffOptions): ChangeReportDto {
  const files = diffFiles(loadFiles(base), loadFiles(head));
  const symbols = diffSymbols(base, head, files);
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
    entries: diffEntries(base, head, symbols),
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

function diffSymbols(base: Db, head: Db, files: readonly FileChangeDto[]): SymbolChangeDto[] {
  // 内容没变的文件里符号不可能变；移动的文件内容相同，也不必逐个比
  const headPaths = files.filter((f) => f.status === "added" || f.status === "modified").map((f) => f.path);
  const basePaths = files.filter((f) => f.status === "removed" || f.status === "modified").map((f) => f.path);
  const before = groupByKey(loadSymbols(base, basePaths));
  const after = groupByKey(loadSymbols(head, headPaths));
  const callersIn = (db: Db) => db.prepare(
    `SELECT COUNT(DISTINCT src_id) AS n FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND dst_id = ?`,
  );
  const headCallers = callersIn(head);
  const baseCallers = callersIn(base);
  const count = (stmt: ReturnType<typeof callersIn>, id: number) => (stmt.get(id) as { n: number }).n;

  const out: SymbolChangeDto[] = [];
  for (const [key, now] of after) {
    const old = before.get(key) ?? [];
    // 同一文件里同名同类的符号（重载、同名闭包）按出现顺序配对
    now.forEach((symbol, i) => {
      const prev = old[i];
      if (!prev) out.push(symbolChange("added", symbol, null, count(headCallers, symbol.id)));
      else if (prev.hash !== symbol.hash) out.push(symbolChange("modified", symbol, prev, count(headCallers, symbol.id)));
    });
    for (const prev of old.slice(now.length)) out.push(symbolChange("removed", null, prev, count(baseCallers, prev.id)));
  }
  for (const [key, old] of before) {
    if (after.has(key)) continue;
    for (const prev of old) out.push(symbolChange("removed", null, prev, count(baseCallers, prev.id)));
  }
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
  for (const [key, entry] of after) {
    if (before.has(key)) continue;
    out.push({ status: "added", id: `entry:${entry.id}`, symbolId: symbolOf(entry), kind: entry.kind, label: entry.label, path: entry.path, via: [] });
  }
  for (const [key, entry] of before) {
    if (after.has(key)) continue;
    out.push({ status: "removed", id: null, symbolId: null, kind: entry.kind, label: entry.label, path: entry.path, via: [] });
  }

  const reached = reachFromChanges(head, symbols);
  for (const [key, entry] of after) {
    if (!before.has(key) || entry.symbolId === null) continue;
    const via = reached.get(entry.symbolId);
    if (!via || via.length === 0) continue;
    out.push({
      status: "affected", id: `entry:${entry.id}`, symbolId: symbolOf(entry), kind: entry.kind, label: entry.label, path: entry.path,
      via: via.sort((a, b) => a.depth - b.depth || a.name.localeCompare(b.name)).slice(0, 8),
    });
  }
  const kindRank: Record<EntryPointKind, number> = { http: 0, cli: 1, main: 2, "public-api": 3, test: 4 };
  const statusRank = { added: 0, removed: 1, affected: 2 } as const;
  return out.sort((a, b) =>
    statusRank[a.status] - statusRank[b.status] || kindRank[a.kind] - kindRank[b.kind] ||
    (a.via[0]?.depth ?? 0) - (b.via[0]?.depth ?? 0) || a.label.localeCompare(b.label));
}

function loadEntries(db: Db): Map<string, EntryRow> {
  // 测试入口成百上千，列出来只会淹没真正的业务入口
  const rows = db.prepare(
    `SELECT e.id, e.kind, e.label, f.path, e.symbol_id AS symbolId
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
  const callers = new Map<number, number[]>();
  const rows = head.prepare(
    `SELECT src_id AS "from", dst_id AS "to" FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND confidence IN ('exact', 'likely')`,
  ).all() as Array<{ from: number; to: number }>;
  for (const row of rows) {
    const bucket = callers.get(row.to);
    if (bucket) bucket.push(row.from); else callers.set(row.to, [row.from]);
  }

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
