import type { Db } from "../db/database.js";
import type { EntryPointKind, IoKind } from "../types.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "options", "head", "all", "route",
]);
const TEST_NAMES = /^(test|it|describe|specify)$/i;

/** 再往下的 I/O 对「这一步要不要步入」已经没有指导意义 */
const IO_REACH_DEPTH = 10;
/** 入口规模只是量级提示，数到这里就停，免得热点入口把整张调用图走一遍 */
const REACH_CAP = 999;

const IO_ORDER: readonly IoKind[] = ["database", "network", "filesystem", "message-queue", "process"];

interface SymbolRow {
  id: number; fileId: number; fileRole: string; name: string; container: string | null;
  exported: number; startLine: number;
}

interface CallRow {
  id: number; fileId: number; callerId: number | null; callee: string; receiver: string | null;
  arguments: string; line: number;
  /** 解析为 external 时落到的包名 */
  external: string | null;
}

interface EntryCandidate {
  kind: EntryPointKind; framework: string | null; symbolId: number | null; fileId: number; line: number; label: string;
  method: string | null; route: string | null; confidence: "exact" | "likely"; evidence: string;
}

export interface EntryAnalysisStats { entries: number; ioSites: number; }

/**
 * 入口识别、I/O 调用点标注，以及单步走读要用的可达性提示。只读解析事实和
 * 调用链接结果，LLM 不参与：模型不可用时走读的每一步照样落在具体调用行上。
 */
export function analyzeEntries(db: Db): EntryAnalysisStats {
  db.exec("DELETE FROM io_reach; DELETE FROM entry_points");

  const symbols = loadSymbols(db);
  const calls = loadCalls(db);
  const entries = dedupeEntries([
    ...symbolEntries(db, symbols),
    ...hintEntries(db, symbols),
    ...registrationEntries(calls, symbols),
    ...testCallEntries(calls, symbols),
  ]);

  db.prepare("UPDATE call_sites SET io_kind = NULL WHERE io_kind IS NOT NULL").run();
  const markIo = db.prepare("UPDATE call_sites SET io_kind = ? WHERE id = ?");
  const ioBySymbol = new Map<number, Set<IoKind>>();
  let ioSites = 0;
  for (const call of calls) {
    const kind = classifyIo(call);
    if (!kind) continue;
    markIo.run(kind, call.id);
    ioSites++;
    if (call.callerId === null) continue;
    const bucket = ioBySymbol.get(call.callerId);
    if (bucket) bucket.add(kind); else ioBySymbol.set(call.callerId, new Set([kind]));
  }

  const adjacency = loadEdges(db);
  const reach = ioReach(adjacency, ioBySymbol, IO_REACH_DEPTH);
  const insertReach = db.prepare("INSERT INTO io_reach (symbol_id, kind, depth) VALUES (?, ?, ?)");
  for (const [symbolId, kinds] of reach) {
    for (const [kind, depth] of kinds) insertReach.run(symbolId, kind, depth);
  }

  // `new Foo()` 落在类符号上，文件数要连它们一起算
  const fileOf = new Map(
    (db.prepare("SELECT id, file_id AS fileId FROM symbols").all() as Array<{ id: number; fileId: number }>)
      .map((row) => [row.id, row.fileId]),
  );
  const insertEntry = db.prepare(
    `INSERT INTO entry_points
       (kind, framework, symbol_id, file_id, line, label, method, route, confidence, evidence,
        reach_symbols, reach_files, reach_io)
     VALUES (@kind, @framework, @symbolId, @fileId, @line, @label, @method, @route, @confidence, @evidence,
        @reachSymbols, @reachFiles, @reachIo)`,
  );
  for (const entry of entries) {
    const scale = entry.symbolId === null ? null : reachScale(entry.symbolId, adjacency, fileOf);
    const io = entry.symbolId === null ? [] : IO_ORDER.filter((kind) => reach.get(entry.symbolId!)?.has(kind));
    insertEntry.run({
      ...entry,
      reachSymbols: scale?.symbols ?? 0,
      reachFiles: scale?.files ?? 0,
      reachIo: io.join(","),
    });
  }

  return { entries: entries.length, ioSites };
}

function loadSymbols(db: Db): SymbolRow[] {
  return db.prepare(
    `SELECT s.id, s.file_id AS fileId, f.role AS fileRole, s.name, s.container,
            s.exported, s.start_line AS startLine
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.kind IN ('function', 'method')`,
  ).all() as SymbolRow[];
}

function loadCalls(db: Db): CallRow[] {
  return db.prepare(
    `SELECT id, file_id AS fileId, caller_symbol_id AS callerId, callee_name AS callee, receiver,
            argument_texts AS arguments, line, target_name AS external
     FROM call_sites`,
  ).all() as CallRow[];
}
function symbolEntries(db: Db, symbols: readonly SymbolRow[]): EntryCandidate[] {
  const out: EntryCandidate[] = [];
  const publicApiFiles = publicApiFileIds(db);
  for (const symbol of symbols) {
    if (symbol.name === "main") {
      out.push(entryFromSymbol(symbol, "main", "main", "语言约定的 main 函数", "exact"));
    }
    if (
      symbol.fileRole === "source" && symbol.name !== "main" &&
      symbol.exported === 1 && symbol.container === null && publicApiFiles.has(symbol.fileId)
    ) {
      out.push(entryFromSymbol(symbol, "public-api", qualifiedName(symbol), "导出的顶层函数", "exact"));
    }
    if (symbol.fileRole === "test" && /^(test|it|should|spec)|^Test[A-Z_]/.test(symbol.name)) {
      out.push(entryFromSymbol(symbol, "test", qualifiedName(symbol), "测试文件中的测试函数", "exact"));
    }
  }
  return out;
}

/**
 * 找真正面向包外的源码入口。`export function` 只说明它可从当前模块导出，
 * 不能说明这个模块就是包的公共表面；把所有模块导出都当入口会让工具函数
 * 淹没入口列表。Node 包按 package.json 入口映射到源码，其他语言按自身的
 * 包入口约定处理。Go 的导出是包级语义，因此保留包内所有导出函数。
 */
function publicApiFileIds(db: Db): Set<number> {
  const packages = db.prepare(
    "SELECT id, dir, entry_points AS entryPoints FROM packages",
  ).all() as Array<{ id: number; dir: string; entryPoints: string }>;
  const files = db.prepare(
    "SELECT id, path, language, package_id AS packageId FROM files",
  ).all() as Array<{ id: number; path: string; language: string; packageId: number | null }>;
  const entryMatchers = new Map<number, RegExp[]>();
  for (const pkg of packages) {
    const entries = parseArray(pkg.entryPoints)
      .filter((entry) => entry !== "package.json")
      .flatMap(sourceEntryCandidates);
    entryMatchers.set(pkg.id, [...new Set(entries)].map(pathPattern));
  }

  const out = new Set<number>();
  for (const file of files) {
    if (file.language === "go") {
      out.add(file.id);
      continue;
    }
    const relative = packageRelativePath(file.path, file.packageId, packages);
    const conventional = /^(?:src\/)?(?:index\.(?:[cm]?[jt]sx?|py)|__init__\.py|lib\.rs|mod\.rs)$/.test(relative);
    const configured = file.packageId !== null &&
      (entryMatchers.get(file.packageId) ?? []).some((matcher) => matcher.test(relative));
    if (conventional || configured) out.add(file.id);
  }

  // barrel 文件通常没有自己的函数，只用 `export * from "./foo"` 暴露实现。
  // 沿解析成功的 re-export 递归扩展，否则真实公共函数仍会全部漏掉。
  const reexports = db.prepare(
    `SELECT file_id AS sourceId, target_file_id AS targetId FROM imports
     WHERE kind = 're-export' AND target_file_id IS NOT NULL`,
  ).all() as Array<{ sourceId: number; targetId: number }>;
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of reexports) {
      if (!out.has(edge.sourceId) || out.has(edge.targetId)) continue;
      out.add(edge.targetId);
      changed = true;
    }
  }
  return out;
}

function packageRelativePath(
  filePath: string,
  packageId: number | null,
  packages: readonly { id: number; dir: string }[],
): string {
  const dir = packages.find((pkg) => pkg.id === packageId)?.dir;
  if (!dir || dir === ".") return filePath;
  return filePath.startsWith(`${dir}/`) ? filePath.slice(dir.length + 1) : filePath;
}

/** dist/foo.js、dist/foo.d.ts 等发布入口都映射回 src/foo 的源码族。 */
function sourceEntryCandidates(entry: string): string[] {
  const clean = entry.startsWith("./") ? entry.slice(2) : entry;
  const source = clean.startsWith("dist/") || clean.startsWith("build/")
    ? `src/${clean.slice(clean.indexOf("/") + 1)}`
    : clean;
  const stem = source.replace(/(?:\.d)?\.(?:[cm]?js|tsx?|jsx|py|rs|go)$/, "");
  return [
    source,
    `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`,
    `${stem}.py`, `${stem}.rs`, `${stem}.go`,
  ];
}

function pathPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function hintEntries(db: Db, symbols: readonly SymbolRow[]): EntryCandidate[] {
  const byFileAndName = new Map(symbols.map((s) => [`${s.fileId}:${s.name}`, s]));
  const rows = db.prepare(
    `SELECT file_id AS fileId, kind, framework, handler_name AS handlerName, line, label, method, route, confidence, evidence
     FROM entry_hints`,
  ).all() as Array<{ fileId: number; kind: "http" | "cli"; framework: string; handlerName: string | null;
    line: number; label: string; method: string | null; route: string | null; confidence: "exact" | "likely"; evidence: string }>;
  return rows.map((row) => ({
    kind: row.kind, framework: row.framework, symbolId: row.handlerName ? byFileAndName.get(`${row.fileId}:${row.handlerName}`)?.id ?? null : null,
    fileId: row.fileId, line: row.line, label: row.label, method: row.method, route: row.route,
    confidence: row.confidence, evidence: row.evidence,
  }));
}

function registrationEntries(calls: readonly CallRow[], symbols: readonly SymbolRow[]): EntryCandidate[] {
  const out: EntryCandidate[] = [];
  for (const call of calls) {
    const method = call.callee.toLowerCase();
    const args = parseArray(call.arguments);

    if (isCliRegistration(call)) {
      const named = resolveHandler(symbols, call.fileId, handlerIdentifier(args.at(-1) ?? ""));
      const command = unquote(args[0])?.trim().split(/\s+/)[0] || commandFromReceiver(call.receiver)
        || named?.symbol.name || call.callee;
      const handler = named ?? inlineHandler(symbols, call.fileId, `CLI ${command}`, call.line);
      out.push({
        kind: "cli", framework: cliFramework(call.callee, call.receiver),
        // 注册调用所在的外层函数不是 handler；匿名闭包没有独立符号时宁可
        // 只识别入口、不把外层初始化函数当成走读起点。
        symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
        label: `CLI ${command}`, method: null, route: null, confidence: handler?.confidence ?? "likely",
        evidence: `${call.receiver ? `${call.receiver}.` : ""}${call.callee}(command, handler) registration`,
      });
    }

    if (!HTTP_METHODS.has(method) || !call.receiver) continue;
    const route = unquote(args[0]);
    if (!route?.startsWith("/")) continue;
    const label = `${method === "route" || method === "all" ? "HTTP" : method.toUpperCase()} ${route}`;
    const handler = resolveHandler(symbols, call.fileId, handlerIdentifier(args.at(-1) ?? ""))
      ?? inlineHandler(symbols, call.fileId, label, call.line);
    const framework = httpFramework(call.receiver, call.callee, args);
    out.push({
      kind: "http", framework, symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
      label,
      method: method === "route" || method === "all" ? null : method.toUpperCase(), route,
      confidence: handler?.confidence ?? "likely",
      evidence: `${call.receiver}.${call.callee}(route, handler) registration`,
    });
  }
  return out;
}

/** 通用的 command/action/handler 名称本身不构成 CLI 证据。 */
function isCliRegistration(call: CallRow): boolean {
  const method = call.callee.toLowerCase();
  const receiver = (call.receiver ?? "").toLowerCase();
  if (/^(addcommand|add_command|subcommand)$/.test(method)) return receiver.length > 0;
  if (method === "command") return /(?:^|[.(_])(program|commander|yargs|cli|cmd)(?:$|[.)_])/.test(receiver);
  if (method === "action") return /program|commander|command|yargs|cli|cmd/.test(receiver);
  if (method === "handler") return /command|yargs|cli/.test(receiver);
  return false;
}

function cliFramework(callee: string, receiver: string | null): string {
  if (/add_command/i.test(callee)) return "Click/Typer";
  if (/addcommand/i.test(callee)) return "Cobra";
  if (/command|action/i.test(callee) && /program|commander|cmd/i.test(receiver ?? "")) return "Commander";
  return "CLI framework";
}

function testCallEntries(calls: readonly CallRow[], symbols: readonly SymbolRow[]): EntryCandidate[] {
  const out: EntryCandidate[] = [];
  for (const call of calls) {
    if (!TEST_NAMES.test(call.callee) || call.callerId !== null) continue;
    const args = parseArray(call.arguments);
    const handler = resolveHandler(symbols, call.fileId, handlerIdentifier(args.at(-1) ?? ""));
    out.push({
      kind: "test", framework: null, symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
      label: unquote(args[0]) ?? `${call.callee} @ ${call.line}`, method: null, route: null,
      confidence: handler?.confidence ?? "likely", evidence: `${call.callee}(name, callback) test registration`,
    });
  }
  return out;
}

/** 调用直接落进这些包就算 I/O；node 内置模块去掉 `node:` 前缀再查 */
const PACKAGE_IO: Readonly<Record<string, IoKind>> = Object.fromEntries([
  ...[
    "better-sqlite3", "sqlite3", "sqlite", "pg", "postgres", "mysql", "mysql2", "mongodb", "mongoose", "redis",
    "ioredis", "@prisma/client", "knex", "typeorm", "sequelize", "drizzle-orm", "kysely", "@libsql/client",
    "sqlalchemy", "psycopg", "psycopg2", "pymysql", "pymongo", "database/sql", "gorm.io/gorm",
    "github.com/jmoiron/sqlx", "rusqlite", "sqlx", "diesel",
  ].map((name) => [name, "database"]),
  ...[
    "axios", "node-fetch", "got", "undici", "superagent", "ky", "http", "https", "http2", "net", "dns",
    "requests", "httpx", "aiohttp", "urllib.request", "urllib3", "net/http", "reqwest", "hyper",
  ].map((name) => [name, "network"]),
  ...["fs", "fs/promises", "fs-extra", "graceful-fs", "shutil", "io/ioutil", "std::fs", "tokio::fs"]
    .map((name) => [name, "filesystem"]),
  ...["child_process", "execa", "cross-spawn", "subprocess", "os/exec", "std::process"].map((name) => [name, "process"]),
  ...[
    "kafkajs", "amqplib", "bullmq", "bull", "@aws-sdk/client-sqs", "nats", "pika", "kafka-python", "confluent_kafka",
    "github.com/segmentio/kafka-go", "lapin", "rdkafka",
  ].map((name) => [name, "message-queue"]),
]);

/**
 * 按落到的包、API 名和接收者认出 I/O 访问。只是标注：走读到这一行时告诉人「这里碰数据库」，
 * 不拿它当终点——函数照样可以继续往下走。
 */
function classifyIo(call: Pick<CallRow, "callee" | "receiver" | "external">): IoKind | null {
  const byPackage = call.external ? PACKAGE_IO[call.external.replace(/^node:/, "")] : undefined;
  if (byPackage) return byPackage;
  const callee = call.callee.toLowerCase();
  const receiver = (call.receiver ?? "").toLowerCase();

  if (/^(query|queryrow|execute|exec|transaction|findunique|findmany|findone|findall|insert|upsert|save|commit|rollback)$/.test(callee) &&
      /(^|\.|_)(db|sql|sqlx|database|pool|connection|conn|cursor|session|prisma|sequelize|knex|repository|repo|collection|model)(\.|_|$)/.test(receiver)) {
    return "database";
  }
  if (/^(readfile|readfilesync|writefile|writefilesync|appendfile|appendfilesync|createreadstream|createwritestream|readdir|readdirsync|mkdir|mkdirsync|unlink|unlinksync|remove|read_to_string|read_dir)$/.test(callee) ||
      (/^(open|create)$/.test(callee) && /(^|\.)(fs|file|path|os)$/.test(receiver))) {
    return "filesystem";
  }
  if (/^(spawn|execfile|execsync|spawnsync|command|popen|system)$/.test(callee) ||
      (callee === "exec" && (receiver === "" || /child_process|command|process/.test(receiver))) ||
      (callee === "run" && /subprocess|command|process/.test(receiver)) ||
      (callee === "new" && /(^|::|\.)command$/.test(receiver))) {
    return "process";
  }
  if (/^(publish|basic_publish|subscribe|basic_consume|sendmessage|sendmessages|receivemessage|sendtoqueue|consume|produce|enqueue|dequeue|ack|nack|xadd|lpush|rpush)$/.test(callee) &&
      /queue|kafka|rabbit|channel|sqs|pubsub|broker|producer|consumer/.test(receiver)) {
    return "message-queue";
  }
  if (callee === "fetch" || /^(axios|got|requesturl|urlopen)$/.test(callee) ||
      (/^(get|post|put|patch|delete|send|request|do)$/.test(callee) && /http|client|axios|request|requests|url/.test(receiver))) {
    return "network";
  }
  if (/^(get|all|run|prepare)$/.test(callee) && /(^|\.|_)(db|sql|database)(\.|_|$)/.test(receiver)) {
    return "database";
  }
  return null;
}

/** 只走确定与可能的调用：多义边是猜的，拿它推「这里会碰数据库」等于把猜测再放大一轮 */
function loadEdges(db: Db): Map<number, number[]> {
  const rows = db.prepare(
    `SELECT src_id AS "from", dst_id AS "to" FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
       AND confidence IN ('exact', 'likely')`,
  ).all() as Array<{ from: number; to: number }>;
  const out = new Map<number, number[]>();
  for (const edge of rows) {
    const bucket = out.get(edge.from);
    if (bucket) bucket.push(edge.to); else out.set(edge.from, [edge.to]);
  }
  return out;
}

/** 每类 I/O 各从「自己就在做」的函数反向扩散，记下每个调用者最少几跳能碰到它 */
function ioReach(
  adjacency: ReadonlyMap<number, readonly number[]>,
  ioBySymbol: ReadonlyMap<number, ReadonlySet<IoKind>>,
  maxDepth: number,
): Map<number, Map<IoKind, number>> {
  const reverse = new Map<number, number[]>();
  for (const [from, targets] of adjacency) {
    for (const to of targets) {
      const bucket = reverse.get(to);
      if (bucket) bucket.push(from); else reverse.set(to, [from]);
    }
  }
  const out = new Map<number, Map<IoKind, number>>();
  for (const kind of IO_ORDER) {
    let frontier = [...ioBySymbol].filter(([, kinds]) => kinds.has(kind)).map(([id]) => id);
    const seen = new Set(frontier);
    for (let depth = 0; depth <= maxDepth && frontier.length > 0; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        const kinds = out.get(id);
        if (kinds) kinds.set(kind, depth); else out.set(id, new Map([[kind, depth]]));
        for (const caller of reverse.get(id) ?? []) {
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

/** 从入口往下能走到多少个仓库内函数、走出入口文件到几个别的文件。是给入口列表排序和提示规模用的量级 */
function reachScale(
  start: number,
  adjacency: ReadonlyMap<number, readonly number[]>,
  fileOf: ReadonlyMap<number, number>,
): { symbols: number; files: number } {
  const seen = new Set([start]);
  const files = new Set<number>();
  const startFile = fileOf.get(start);
  const queue = [start];
  while (queue.length > 0 && seen.size <= REACH_CAP) {
    const id = queue.shift() as number;
    for (const next of adjacency.get(id) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      const file = fileOf.get(next);
      if (file !== undefined && file !== startFile) files.add(file);
      queue.push(next);
    }
  }
  return { symbols: Math.min(seen.size - 1, REACH_CAP), files: files.size };
}

function entryFromSymbol(symbol: SymbolRow, kind: EntryPointKind, label: string, evidence: string, confidence: "exact" | "likely"): EntryCandidate {
  return { kind, framework: null, symbolId: symbol.id, fileId: symbol.fileId, line: symbol.startLine, label, method: null, route: null, confidence, evidence };
}

function resolveHandler(
  symbols: readonly SymbolRow[], fileId: number, name: string | null,
): { symbol: SymbolRow; confidence: "exact" | "likely" } | null {
  if (!name) return null;
  const local = symbols.filter((s) => s.fileId === fileId && s.name === name);
  if (local.length === 1) return { symbol: local[0] as SymbolRow, confidence: "exact" };
  const exported = symbols.filter((s) => s.exported === 1 && s.name === name);
  // 尚未沿 import specifier 证明跨文件绑定，只能沿用调用链接器的 likely 语义。
  return exported.length === 1
    ? { symbol: exported[0] as SymbolRow, confidence: "likely" }
    : null;
}

/**
 * 解析器给注册调用里的内联回调合成了符号（名字与入口标签同规则，同名时带 ` #n`）。
 * 回调总在注册调用那一行或之后开始，取离它最近的那个。
 */
function inlineHandler(
  symbols: readonly SymbolRow[], fileId: number, name: string, line: number,
): { symbol: SymbolRow; confidence: "exact" } | null {
  let best: SymbolRow | null = null;
  for (const symbol of symbols) {
    if (symbol.fileId !== fileId || symbol.container !== null || symbol.startLine < line) continue;
    if (symbol.name !== name && !symbol.name.startsWith(`${name} #`)) continue;
    if (!best || symbol.startLine < best.startLine) best = symbol;
  }
  return best ? { symbol: best, confidence: "exact" } : null;
}

function commandFromReceiver(receiver: string | null): string | null {
  const match = receiver?.match(/\.command\(\s*["'`]([^"'`\s]+)/);
  return match?.[1] ?? null;
}

function handlerIdentifier(text: string): string | null {
  // Axum `.route("/x", get(handler))` 与普通 `app.get("/x", handler)`。
  const value = text.trim();
  if (/^(?:async\s+)?(?:function\b|(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)/.test(value)) return null;
  const wrapped = value.match(/^(?:get|post|put|patch|delete|head|options)\s*\(\s*([A-Za-z_$][\w$]*)\s*\)$/i);
  if (wrapped?.[1]) return wrapped[1];
  const direct = value.match(/^(?:[A-Za-z_$][\w$]*[.:])*([A-Za-z_$][\w$]*)$/);
  return direct?.[1] ?? null;
}

function httpFramework(receiver: string, callee: string, args: readonly string[]): string {
  if (/fastify/i.test(receiver)) return "Fastify";
  if (callee === callee.toUpperCase()) return "Gin";
  if (callee.toLowerCase() === "route" && /^(get|post|put|patch|delete)\s*\(/i.test(args[1] ?? "")) return "Axum";
  return "Express-compatible";
}

function qualifiedName(symbol: SymbolRow): string {
  return symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
}

function parseArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch { return []; }
}

function unquote(text: string | undefined): string | null {
  if (!text || text.length < 2) return null;
  const quote = text[0];
  return (quote === "'" || quote === '"' || quote === "`") && text.at(-1) === quote ? text.slice(1, -1) : null;
}

function dedupeEntries(entries: EntryCandidate[]): EntryCandidate[] {
  // `program.command("scan").action(fn)` 在同一行产生两次注册：只有 action 那次带得出 handler
  const out = new Map<string, EntryCandidate>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.fileId}:${entry.line}:${entry.route ?? ""}:${entry.label}`;
    const existing = out.get(key);
    if (!existing || (existing.symbolId === null && entry.symbolId !== null)) out.set(key, entry);
  }
  return [...out.values()];
}
