import { join } from "node:path";
import { getModuleCard } from "./db/boundary.js";
import { INDEX_DIR, type Db } from "./db/database.js";
import { inBatches, resolveScope, scopeFunctions } from "./db/scope.js";
import { JsonListFile } from "./json-file.js";
import type {
  LensValueDto,
  UnderstandingCountsDto,
  UnderstandingDto,
  UnderstandingHow,
  UnderstandingMarkDto,
} from "./types.js";

const FILE = "understanding.json";
const STALE_LISTED = 50;
const KEY_ENTRY_KINDS = ["http", "cli", "main", "public-api"];
/** 热点入口能走遍大半个仓库：每条调用链只数离入口最近的这么多个函数，免得每次都把整张调用图走一遍 */
const ENTRY_FLOW_CAP = 1000;

interface StoredMark {
  key: string;
  kind: "symbol" | "file" | "scope";
  path: string;
  label: string;
  /** 标记时的内容指纹：符号、文件取内容哈希，模块取对外接口签名的指纹 */
  hash: string;
  at: string;
  how: UnderstandingHow;
}

export class UnderstandingInputError extends Error {}

/**
 * 理解账本存在索引旁边，和笔记一样不放进 index.db：索引随时可能重建，人看懂了什么不能跟着丢。
 * 它是个人的——每个人对代码的理解不同，不随仓库提交。
 */
export function understandingPath(root: string): string {
  return join(root, INDEX_DIR, FILE);
}

/**
 * 「我看懂了」。按稳定的路径和名字记下当时的内容指纹；之后代码一改指纹对不上，这条理解就
 * 自动过期。函数和文件看的是内容，模块看的是对外接口——接口没变，内部怎么改都还算看懂了接口。
 */
export function markUnderstood(db: Db, root: string, nodeId: string, how: UnderstandingHow = "manual"): UnderstandingMarkDto {
  const mark = describe(db, nodeId, how);
  const file = ledger(root);
  file.write([...file.read().filter((m) => m.key !== mark.key), mark]);
  return present(db, mark, new Map());
}

export function unmark(root: string, key: string): boolean {
  return ledger(root).remove((mark) => mark.key === key);
}

/** 账本全貌：整体和主干的覆盖、看懂后又被改过的、每个入口那条调用链看懂了多少 */
export function getUnderstanding(db: Db, root: string): UnderstandingDto {
  const marks = readMarks(root);
  const index = markIndex(marks);
  const functions = allFunctions(db);
  const calls = callGraph(db);
  const entries = entrySymbols(db);
  const key = reachable(calls, entries);

  const cache = new Map<string, string | null>();
  const presented = marks.map((mark) => present(db, mark, cache));
  return {
    summary: {
      all: countStatus(functions, index),
      key: countStatus(functions.filter((fn) => key.has(fn.id)), index),
      marks: marks.length,
    },
    stale: presented.filter((m) => m.status === "stale").sort((a, b) => b.at.localeCompare(a.at)).slice(0, STALE_LISTED),
    entries: marks.length === 0 ? {} : entryProgress(entries, calls, functions, index),
  };
}

/** 一批图节点各自的理解覆盖，画「我的理解」视角用 */
export function understandingLens(db: Db, root: string, nodeIds: readonly string[]): Record<string, LensValueDto> {
  const index = markIndex(readMarks(root));
  const out: Record<string, LensValueDto> = {};
  for (const id of nodeIds) {
    const scope = resolveScope(db, id);
    if (!scope) continue;
    const functions = scopeFunctions(db, scope);
    const fileHashes = fileHashesOf(db, functions.map((fn) => fn.fileId));
    let understood = 0;
    let stale = 0;
    for (const fn of functions) {
      const row = withKey(db, fn.id, fileHashes);
      if (!row) continue;
      const s = statusOf(row, index);
      if (s === "understood") understood++;
      else if (s === "stale") stale++;
    }
    const value: LensValueDto = { total: functions.length, understood, stale };
    if (scope.kind === "file") {
      const mark = index.files.get(scope.path);
      const hash = (db.prepare("SELECT hash FROM files WHERE path = ?").get(scope.path) as { hash: string } | undefined)?.hash;
      value.mark = mark ? (mark.hash === hash ? "understood" : "stale") : null;
      if (mark) value.key = mark.key;
    }
    if (scope.kind === "symbol" && functions[0]) {
      const row = withKey(db, functions[0].id, fileHashes);
      const s = row ? statusOf(row, index) : null;
      value.mark = s === "understood" || s === "stale" ? s : null;
      // 函数没被单独标过、是随整个文件一起标的，撤销时撤的是文件那条
      if (row && value.mark) value.key = index.symbols.has(row.key) ? row.key : `path:${row.path}`;
    }
    if (scope.kind === "package" || scope.kind === "directory" || scope.kind === "repo") {
      const mark = index.scopes.get(`scope:${id}`);
      if (mark) {
        value.mark = getModuleCard(db, id)?.apiHash === mark.hash ? "understood" : "stale";
        value.key = mark.key;
      }
    }
    out[id] = value;
  }
  return out;
}

// ---------------------------------------------------------------------------

interface FunctionRow {
  id: number;
  key: string;
  path: string;
  hash: string;
  fileHash: string;
}

interface MarkIndex {
  symbols: Map<string, StoredMark>;
  /** 按文件路径 */
  files: Map<string, StoredMark>;
  scopes: Map<string, StoredMark>;
}

function markIndex(marks: readonly StoredMark[]): MarkIndex {
  const symbols = new Map<string, StoredMark>();
  const files = new Map<string, StoredMark>();
  const scopes = new Map<string, StoredMark>();
  for (const mark of marks) {
    if (mark.kind === "symbol") symbols.set(mark.key, mark);
    else if (mark.kind === "file") files.set(mark.path, mark);
    else scopes.set(mark.key, mark);
  }
  return { symbols, files, scopes };
}

/** 函数自己被标过就看它自己；没有时看所在文件有没有被整体标过 */
function statusOf(fn: FunctionRow, index: MarkIndex): "understood" | "stale" | null {
  const own = index.symbols.get(fn.key);
  if (own) return own.hash === fn.hash ? "understood" : "stale";
  const file = index.files.get(fn.path);
  if (file) return file.hash === fn.fileHash ? "understood" : "stale";
  return null;
}

function symbolKeyOf(path: string, container: string | null, name: string, kind: string): string {
  return `symbol:${path}#${container ? `${container}.` : ""}${name}#${kind}`;
}

function allFunctions(db: Db): FunctionRow[] {
  return (db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.hash, f.path, f.hash AS fileHash
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.role = 'source' AND s.kind IN ('function', 'method') AND s.implemented = 1`,
  ).all() as Array<{ id: number; name: string; container: string | null; kind: string; hash: string; path: string; fileHash: string }>)
    .map((row) => ({
      id: row.id, key: symbolKeyOf(row.path, row.container, row.name, row.kind), path: row.path, hash: row.hash, fileHash: row.fileHash,
    }));
}

function withKey(db: Db, symbolId: number, fileHashes: ReadonlyMap<number, string>): FunctionRow | null {
  const row = db.prepare(
    `SELECT s.id, s.name, s.container, s.kind, s.hash, s.file_id AS fileId, f.path
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  ).get(symbolId) as { id: number; name: string; container: string | null; kind: string; hash: string; fileId: number; path: string } | undefined;
  if (!row) return null;
  return {
    id: row.id, key: symbolKeyOf(row.path, row.container, row.name, row.kind), path: row.path, hash: row.hash,
    fileHash: fileHashes.get(row.fileId) ?? "",
  };
}

function fileHashesOf(db: Db, fileIds: readonly number[]): Map<number, string> {
  const unique = [...new Set(fileIds)];
  return new Map(inBatches(unique, (batch) => db.prepare(
    `SELECT id, hash FROM files WHERE id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; hash: string }>).map((row) => [row.id, row.hash]));
}

function countStatus(list: readonly FunctionRow[], index: MarkIndex): UnderstandingCountsDto {
  let understood = 0;
  let stale = 0;
  for (const fn of list) {
    const status = statusOf(fn, index);
    if (status === "understood") understood++;
    else if (status === "stale") stale++;
  }
  return { total: list.length, understood, stale };
}

type CallGraph = Map<number, number[]>;

/** 确定和可能的调用；多义边是猜的，不拿它推「走得到」 */
function callGraph(db: Db): CallGraph {
  const graph: CallGraph = new Map();
  for (const edge of db.prepare(
    `SELECT src_id AS "from", dst_id AS "to" FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND confidence IN ('exact', 'likely')`,
  ).all() as Array<{ from: number; to: number }>) {
    const bucket = graph.get(edge.from);
    if (bucket) bucket.push(edge.to); else graph.set(edge.from, [edge.to]);
  }
  return graph;
}

/** 主入口（HTTP、CLI、main、公共 API）的处理函数；从它们沿调用走得到的就是主干，系统真正在跑的那部分 */
function entrySymbols(db: Db): number[] {
  return (db.prepare(
    `SELECT DISTINCT symbol_id AS id FROM entry_points WHERE symbol_id IS NOT NULL AND kind IN (${KEY_ENTRY_KINDS.map(() => "?").join(",")})`,
  ).all(...KEY_ENTRY_KINDS) as Array<{ id: number }>).map((row) => row.id);
}

/** 从这些函数出发沿调用走得到的函数，含出发点。给了上限时离出发点近的先数，数够为止 */
function reachable(graph: CallGraph, starts: readonly number[], cap = Number.POSITIVE_INFINITY): Set<number> {
  const seen = new Set(starts);
  const queue = [...starts];
  for (let i = 0; i < queue.length && seen.size < cap; i++) {
    for (const next of graph.get(queue[i]!) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
    }
  }
  return seen;
}

/** 每个入口从处理函数往下那条调用链上，看懂了几个函数、几个看懂后又被改过 */
function entryProgress(
  entries: readonly number[],
  calls: CallGraph,
  functions: readonly FunctionRow[],
  index: MarkIndex,
): Record<string, UnderstandingCountsDto> {
  const byId = new Map(functions.map((fn) => [fn.id, fn]));
  const out: Record<string, UnderstandingCountsDto> = {};
  for (const entry of entries) {
    const flow = [...reachable(calls, [entry], ENTRY_FLOW_CAP)].flatMap((id) => byId.get(id) ?? []);
    const counts = countStatus(flow, index);
    if (counts.understood + counts.stale > 0) out[`sym:${entry}`] = counts;
  }
  return out;
}

function describe(db: Db, nodeId: string, how: UnderstandingHow): StoredMark {
  const at = new Date().toISOString();
  if (nodeId.startsWith("sym:")) {
    const row = db.prepare(
      `SELECT s.name, s.container, s.kind, s.hash, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    ).get(Number(nodeId.slice(4))) as { name: string; container: string | null; kind: string; hash: string; path: string } | undefined;
    if (!row) throw new UnderstandingInputError("符号不存在");
    return {
      key: symbolKeyOf(row.path, row.container, row.name, row.kind), kind: "symbol", path: row.path,
      label: row.container ? `${row.container}.${row.name}` : row.name, hash: row.hash, at, how,
    };
  }
  if (nodeId.startsWith("file:")) {
    const row = db.prepare("SELECT path, hash FROM files WHERE id = ?").get(Number(nodeId.slice(5))) as { path: string; hash: string } | undefined;
    if (!row) throw new UnderstandingInputError("文件不存在");
    return { key: `path:${row.path}`, kind: "file", path: row.path, label: row.path.split("/").at(-1) ?? row.path, hash: row.hash, at, how };
  }
  if (/^(?:pkg|dir):/.test(nodeId)) {
    const card = getModuleCard(db, nodeId);
    if (!card) throw new UnderstandingInputError("节点不存在");
    return { key: `scope:${nodeId}`, kind: "scope", path: card.path, label: card.label, hash: card.apiHash, at, how };
  }
  throw new UnderstandingInputError("只能标记函数、文件、包或目录");
}

function present(db: Db, mark: StoredMark, cache: Map<string, string | null>): UnderstandingMarkDto {
  const base = { key: mark.key, kind: mark.kind, label: mark.label, path: mark.path, at: mark.at, how: mark.how };
  let current: { nodeId: string; hash: string } | null = null;
  if (mark.kind === "symbol") {
    const [, rest = ""] = mark.key.split("symbol:");
    const [path = "", qualified = "", kind = ""] = rest.split("#");
    const dot = qualified.lastIndexOf(".");
    const container = dot >= 0 ? qualified.slice(0, dot) : null;
    const name = dot >= 0 ? qualified.slice(dot + 1) : qualified;
    const row = db.prepare(
      `SELECT s.id, s.hash FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE f.path = ? AND s.name = ? AND s.kind = ? AND s.container IS ? ORDER BY s.start_line LIMIT 1`,
    ).get(path, name, kind, container) as { id: number; hash: string } | undefined;
    if (row) current = { nodeId: `sym:${row.id}`, hash: row.hash };
  } else if (mark.kind === "file") {
    const row = db.prepare("SELECT id, hash FROM files WHERE path = ?").get(mark.path) as { id: number; hash: string } | undefined;
    if (row) current = { nodeId: `file:${row.id}`, hash: row.hash };
  } else {
    const nodeId = mark.key.slice("scope:".length);
    if (!cache.has(nodeId)) cache.set(nodeId, getModuleCard(db, nodeId)?.apiHash ?? null);
    const hash = cache.get(nodeId) ?? null;
    if (hash !== null) current = { nodeId, hash };
  }
  if (current === null) return { ...base, nodeId: null, status: "missing" };
  return { ...base, nodeId: current.nodeId, status: current.hash === mark.hash ? "understood" : "stale" };
}

function ledger(root: string): JsonListFile<StoredMark> {
  return new JsonListFile(understandingPath(root), "marks", "理解账本", isStoredMark);
}

function readMarks(root: string): StoredMark[] {
  return ledger(root).read();
}

function isStoredMark(item: unknown): item is StoredMark {
  const mark = (typeof item === "object" && item !== null ? item : {}) as Partial<StoredMark>;
  return typeof mark.key === "string" && typeof mark.hash === "string" && typeof mark.path === "string" &&
    (mark.kind === "symbol" || mark.kind === "file" || mark.kind === "scope");
}
