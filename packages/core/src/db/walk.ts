import type {
  CallKind, Confidence, EntryPointDto, IoKind, IoReachDto, Language, SymbolKind, UnresolvedReason, WalkCallDto,
  WalkFrameDto, WalkTargetDto,
} from "../types.js";
import type { Db } from "./database.js";
import { symbolKey } from "./queries.js";
import { getCachedSemantic, semanticLanguage } from "./semantic.js";

interface EntryRow {
  id: number; kind: EntryPointDto["kind"]; framework: string | null; symbolId: number | null; fileId: number;
  filePath: string; fileRole: EntryPointDto["fileRole"]; line: number; label: string; method: string | null;
  route: string | null; confidence: "exact" | "likely"; evidence: string;
  reachSymbols: number; reachFiles: number; reachIo: string;
}

interface SymbolRow {
  id: number; name: string; container: string | null; kind: SymbolKind; fileId: number; filePath: string;
  language: Language; startLine: number; endLine: number; signature: string | null; hash: string;
}

interface CallRow {
  id: number; line: number; column: number; callee: string; receiver: string | null; receiverType: string | null;
  kind: CallKind; arguments: string; resolution: Confidence; targetId: number | null; targetName: string | null;
  candidates: string | null; io: IoKind | null;
}

/** 能走的入口排前面，同类里往下走得越远越靠前：越深的入口越值得单步看 */
export function getEntryPoints(db: Db): EntryPointDto[] {
  return (db.prepare(
    `SELECT e.id, e.kind, e.framework, e.symbol_id AS symbolId, e.file_id AS fileId, f.path AS filePath,
            f.role AS fileRole, e.line, e.label, e.method, e.route, e.confidence, e.evidence,
            e.reach_symbols AS reachSymbols, e.reach_files AS reachFiles, e.reach_io AS reachIo
     FROM entry_points e JOIN files f ON f.id = e.file_id
     ORDER BY CASE WHEN e.symbol_id IS NOT NULL AND e.reach_symbols > 0 THEN 0 ELSE 1 END,
              CASE e.kind WHEN 'http' THEN 0 WHEN 'cli' THEN 1 WHEN 'main' THEN 2
                   WHEN 'public-api' THEN 3 WHEN 'test' THEN 4 ELSE 5 END,
              e.reach_files DESC, e.reach_symbols DESC, e.label, f.path, e.line`,
  ).all() as EntryRow[]).map((row) => ({
    id: `entry:${row.id}`, kind: row.kind, framework: row.framework,
    symbolId: row.symbolId === null ? null : `sym:${row.symbolId}`, fileId: `file:${row.fileId}`,
    filePath: row.filePath, fileRole: row.fileRole, line: row.line, label: row.label, method: row.method,
    route: row.route, confidence: row.confidence, evidence: row.evidence,
    reachSymbols: row.reachSymbols, reachFiles: row.reachFiles,
    reachIo: row.reachIo === "" ? [] : (row.reachIo.split(",") as IoKind[]),
  }));
}

/**
 * 单步走读的一帧。调用按 (表达式起始行, 结束字节) 排：跨行时就是源码自上而下的阅读顺序，
 * 同一行里实参先于外层调用结束，`openDb(indexPath(root))` 因此先走 indexPath；
 * 跨行的链式调用整条算作起始那一行，`a\n.b()\n.c()` 依次是 b、c。
 */
export function getWalkFrame(db: Db, symbolId: number): WalkFrameDto | null {
  const symbol = db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.file_id AS fileId, f.path AS filePath, f.language,
            s.start_line AS startLine, s.end_line AS endLine, s.signature, s.hash
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  ).get(symbolId) as SymbolRow | undefined;
  if (!symbol) return null;

  const rows = db.prepare(
    `SELECT id, CASE WHEN name_line > 0 THEN name_line ELSE line END AS line, name_col AS "column",
            callee_name AS callee, receiver, receiver_type AS receiverType, call_kind AS kind,
            argument_texts AS arguments, resolution, target_symbol_id AS targetId, target_name AS targetName,
            candidates, io_kind AS io
     FROM call_sites WHERE caller_symbol_id = ? ORDER BY call_sites.line, end_byte, id`,
  ).all(symbolId) as CallRow[];

  const candidateIds = new Map(rows.map((row) => [row.id, parseIds(row.candidates)]));
  const targets = loadTargets(db, [
    ...rows.flatMap((row) => (row.targetId === null ? [] : [row.targetId])),
    ...[...candidateIds.values()].flat(),
  ]);
  const libraries = importedExternals(db, rows);
  const params = paramNames(db, symbolId);

  const calls: WalkCallDto[] = rows.map((row) => {
    const candidates = row.resolution === "ambiguous"
      ? (candidateIds.get(row.id) ?? []).flatMap((id) => targets.get(id) ?? [])
      : null;
    return {
      id: `call:${row.id}`, line: row.line, column: row.column, callee: row.callee, receiver: row.receiver,
      kind: row.kind, arguments: parseStrings(row.arguments), resolution: row.resolution,
      target: row.targetId === null ? null : targets.get(row.targetId) ?? null,
      candidates: candidates && candidates.length > 0 ? candidates : null,
      external: row.targetName,
      ...(row.resolution === "external" && row.targetName !== null && !libraries.has(row.targetName)
        ? { builtin: true } : {}),
      unresolved: row.resolution === "unresolved" ? unresolvedReason(row, params) : null,
      io: row.io,
    };
  });

  return {
    id: `sym:${symbol.id}`, name: qualified(symbol), kind: symbol.kind, fileId: `file:${symbol.fileId}`,
    filePath: symbol.filePath, language: symbol.language, startLine: symbol.startLine, endLine: symbol.endLine,
    signature: symbol.signature, summary: shortSummary(db, symbol),
    reaches: loadReaches(db, [symbol.id]).get(symbol.id) ?? [], calls,
  };
}

/** 这一帧里出现的外部名中，有文件 import 过的那些是库；其余是语言内置 */
function importedExternals(db: Db, rows: readonly CallRow[]): Set<string> {
  const names = [...new Set(rows.flatMap((row) => (row.resolution === "external" && row.targetName ? [row.targetName] : [])))];
  if (names.length === 0) return new Set();
  return new Set((db.prepare(
    `SELECT DISTINCT external_name AS name FROM imports WHERE external_name IN (${names.map(() => "?").join(",")})`,
  ).all(...names) as Array<{ name: string }>).map((row) => row.name));
}

/** 参数名；解构参数 `{ onClose }: Props` 存的是整段模式，里面的名字都算 */
function paramNames(db: Db, symbolId: number): Set<string> {
  const row = db.prepare("SELECT params FROM symbols WHERE id = ?").get(symbolId) as { params: string | null } | undefined;
  try {
    const params = JSON.parse(row?.params ?? "[]") as Array<{ name?: string }>;
    return new Set(params.flatMap((param) => param.name?.match(/[A-Za-z_$][\w$]*/g) ?? []));
  } catch { return new Set(); }
}

function unresolvedReason(row: CallRow, params: ReadonlySet<string>): UnresolvedReason {
  const receiver = row.receiver ?? "";
  if (receiver === "") {
    const hint = row.receiverType ?? "";
    // 裸调用带着类型标注线索，几乎都是 `onDone: () => void` 这样的函数参数
    if (params.has(row.callee) || /^[PCT]:/.test(hint)) return { kind: "callback" };
    const source = hint.match(/^[RAD]:(.+)$/)?.[1];
    return {
      kind: "function-value",
      source: source ? `${source}()` : null,
      ...(hint.startsWith("D:") ? { destructured: true } : {}),
    };
  }
  if (receiver === "this" || receiver === "self") return { kind: "inherited" };
  if (receiver.includes("(")) return { kind: "chained" };
  const hint = row.receiverType ?? "";
  const source = hint.match(/^[RAD]:(.+)$/)?.[1];
  if (source) return { kind: "untyped", source: `${source}()` };
  return hint === "P:" ? { kind: "untyped", param: true } : { kind: "untyped" };
}

function loadTargets(db: Db, ids: readonly number[]): Map<number, WalkTargetDto> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  // 「还能走几步」与走读列表的默认口径一致：能落到仓库内的调用，加上 I/O 访问
  const rows = db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.file_id AS fileId, f.path AS filePath, f.language,
            s.start_line AS startLine, s.end_line AS endLine, s.signature, s.hash,
            (SELECT COUNT(*) FROM call_sites c WHERE c.caller_symbol_id = s.id
               AND (c.resolution IN ('exact', 'likely', 'ambiguous') OR c.io_kind IS NOT NULL)) AS steps
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id IN (${placeholders})`,
  ).all(...unique) as Array<SymbolRow & { steps: number }>;
  const reaches = loadReaches(db, unique);
  return new Map(rows.map((row) => [row.id, {
    id: `sym:${row.id}`, name: qualified(row), kind: row.kind, fileId: `file:${row.fileId}`,
    filePath: row.filePath, line: row.startLine, steps: row.steps, summary: shortSummary(db, row),
    reaches: reaches.get(row.id) ?? [],
  }]));
}

function loadReaches(db: Db, ids: readonly number[]): Map<number, IoReachDto[]> {
  const out = new Map<number, IoReachDto[]>();
  if (ids.length === 0) return out;
  const rows = db.prepare(
    `SELECT symbol_id AS symbolId, kind, depth FROM io_reach
     WHERE symbol_id IN (${ids.map(() => "?").join(",")}) ORDER BY depth, kind`,
  ).all(...ids) as Array<{ symbolId: number; kind: IoKind; depth: number }>;
  for (const row of rows) {
    const bucket = out.get(row.symbolId);
    const item = { kind: row.kind, depth: row.depth };
    if (bucket) bucket.push(item); else out.set(row.symbolId, [item]);
  }
  return out;
}

function shortSummary(db: Db, symbol: SymbolRow): string | null {
  const key = symbolKey(symbol.filePath, symbol.container, symbol.name, symbol.startLine);
  return getCachedSemantic(db, "symbol", key, "tooltip-summary", semanticLanguage(db), symbol.hash)?.content ?? null;
}

function qualified(symbol: Pick<SymbolRow, "name" | "container">): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

function parseIds(raw: string | null): number[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((id): id is number => Number.isInteger(id)) : [];
  } catch { return []; }
}

function parseStrings(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}
