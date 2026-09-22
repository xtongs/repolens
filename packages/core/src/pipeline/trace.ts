import { createHash } from "node:crypto";
import type { Db } from "../db/database.js";
import type { BoundaryKind, Confidence, EntryPointKind, ParamDto } from "../types.js";

const HTTP_METHODS = new Set([
  "get", "post", "put", "patch", "delete", "options", "head", "all", "route",
]);
const TEST_NAMES = /^(test|it|describe|specify)$/i;

interface SymbolRow {
  id: number; fileId: number; filePath: string; fileRole: string; name: string; container: string | null;
  kind: string; exported: number; startLine: number; params: string | null; returnType: string | null; hash: string;
}

interface CallRow {
  id: number; fileId: number; filePath: string; callerId: number | null; callee: string; receiver: string | null;
  calleePath: string | null; argCount: number; arguments: string; line: number;
}

interface EntryCandidate {
  kind: EntryPointKind; framework: string | null; symbolId: number | null; fileId: number; line: number; label: string;
  method: string | null; route: string | null; confidence: "exact" | "likely"; evidence: string;
}

interface BoundaryCandidate {
  kind: BoundaryKind; symbolId: number | null; fileId: number; callSiteId: number; line: number; callee: string;
  confidence: "exact" | "likely"; evidence: string;
}

interface CallEdge { from: number; to: number; line: number; confidence: "exact" | "likely"; }

export interface TraceAnalysisStats { entries: number; boundaries: number; traces: number; }

/**
 * 从解析事实构建入口、I/O 边界和最短关键链路。LLM 不参与这个阶段：即使模型
 * 不可用，链路的每一步仍能回到具体符号、调用行和置信度。
 */
export function analyzeTraces(db: Db): TraceAnalysisStats {
  db.exec("DELETE FROM trace_steps; DELETE FROM traces; DELETE FROM boundaries; DELETE FROM entry_points");

  const symbols = loadSymbols(db);
  const byId = new Map(symbols.map((symbol) => [symbol.id, symbol]));
  const calls = loadCalls(db);
  const entries = dedupeEntries([
    ...symbolEntries(db, symbols),
    ...hintEntries(db, symbols),
    ...registrationEntries(calls, symbols),
    ...testCallEntries(calls, symbols),
  ]);
  const boundaries = dedupeBoundaries(calls.map(classifyBoundary).filter(isPresent));

  const insertEntry = db.prepare(
    `INSERT INTO entry_points
       (kind, framework, symbol_id, file_id, line, label, method, route, confidence, evidence)
     VALUES (@kind, @framework, @symbolId, @fileId, @line, @label, @method, @route, @confidence, @evidence)`,
  );
  const entryIds = new Map<EntryCandidate, number>();
  for (const entry of entries) entryIds.set(entry, Number(insertEntry.run(entry).lastInsertRowid));

  const insertBoundary = db.prepare(
    `INSERT INTO boundaries
       (kind, symbol_id, file_id, call_site_id, line, callee, confidence, evidence)
     VALUES (@kind, @symbolId, @fileId, @callSiteId, @line, @callee, @confidence, @evidence)`,
  );
  const boundaryIds = new Map<BoundaryCandidate, number>();
  for (const boundary of boundaries) {
    boundaryIds.set(boundary, Number(insertBoundary.run(boundary).lastInsertRowid));
  }

  const adjacency = loadEdges(db);
  const boundariesBySymbol = new Map<number, BoundaryCandidate[]>();
  for (const boundary of boundaries) {
    if (boundary.symbolId === null) continue;
    const bucket = boundariesBySymbol.get(boundary.symbolId);
    if (bucket) bucket.push(boundary);
    else boundariesBySymbol.set(boundary.symbolId, [boundary]);
  }
  const boundaryDistance = distanceToBoundary(adjacency, boundariesBySymbol, 8);
  const callsByCallerLine = indexCalls(calls);

  const insertTrace = db.prepare(
    `INSERT OR IGNORE INTO traces (entry_id, boundary_id, label, confidence, fingerprint)
     VALUES (@entryId, @boundaryId, @label, @confidence, @fingerprint)`,
  );
  const insertStep = db.prepare(
    `INSERT INTO trace_steps
       (trace_id, ordinal, kind, source, confidence, label, symbol_id, file_id, line, call_file_id, call_line, callee, arg_count, arguments, params, return_type)
     VALUES
       (@traceId, @ordinal, @kind, @source, @confidence, @label, @symbolId, @fileId, @line, @callFileId, @callLine, @callee, @argCount, @arguments, @params, @returnType)`,
  );

  let traceCount = 0;
  for (const entry of entries) {
    if (entry.symbolId === null) continue;
    if (!boundaryDistance.has(entry.symbolId)) continue;
    const paths = pathsToBoundaries(
      entry.symbolId, adjacency, boundariesBySymbol, boundaryDistance, 8, 24,
    );
    for (const found of paths) {
      const boundaryId = boundaryIds.get(found.boundary);
      const entryId = entryIds.get(entry);
      if (boundaryId === undefined || entryId === undefined) continue;
      const pathConfidence = found.edges.some((edge) => edge.confidence === "likely") ||
          entry.confidence === "likely" || found.boundary.confidence === "likely"
        ? "likely" : "exact";
      const boundaryCall = calls.find((call) => call.id === found.boundary.callSiteId);
      const fingerprint = traceFingerprint(
        entry, found.symbols, found.edges, found.boundary, boundaryCall, byId,
      );
      const label = `${entry.label} → ${boundaryLabel(found.boundary.kind)} · ${found.boundary.callee}`;
      const inserted = insertTrace.run({
        entryId, boundaryId, label, confidence: pathConfidence, fingerprint,
      });
      // 完全等价的路径可能由多个启发式候选汇合而来。fingerprint 唯一约束
      // 已经保留了第一条，此时不能再次向同一个 trace 写 ordinal=0。
      if (inserted.changes === 0) continue;
      const traceId = Number(inserted.lastInsertRowid);

      const first = byId.get(found.symbols[0] as number);
      if (!first) continue;
      insertStep.run({
        traceId, ordinal: 0, kind: "entry",
        source: entry.confidence === "exact" ? "deterministic" : "inferred",
        confidence: entry.confidence, label: entry.label, symbolId: first.id, fileId: first.fileId,
        line: first.startLine, callFileId: null, callLine: null, callee: null, argCount: 0,
        arguments: "[]", params: first.params ?? "[]",
        returnType: first.returnType,
      });

      for (let i = 1; i < found.symbols.length; i++) {
        const symbol = byId.get(found.symbols[i] as number);
        const edge = found.edges[i - 1];
        if (!symbol || !edge) continue;
        const call = callsByCallerLine.get(`${edge.from}:${edge.line}`)?.find((item) =>
          item.callee === symbol.name || item.calleePath?.endsWith(`.${symbol.name}`),
        );
        insertStep.run({
          traceId, ordinal: i, kind: "call",
          source: edge.confidence === "exact" ? "deterministic" : "inferred",
          confidence: edge.confidence, label: qualifiedName(symbol), symbolId: symbol.id, fileId: symbol.fileId,
          line: symbol.startLine, callFileId: byId.get(edge.from)?.fileId ?? null, callLine: edge.line,
          callee: symbol.name, argCount: call?.argCount ?? 0, arguments: call?.arguments ?? "[]",
          params: symbol.params ?? "[]", returnType: symbol.returnType,
        });
      }

      insertStep.run({
        traceId, ordinal: found.symbols.length, kind: "boundary",
        source: found.boundary.confidence === "exact" ? "deterministic" : "inferred",
        confidence: found.boundary.confidence,
        label: `${boundaryLabel(found.boundary.kind)} · ${found.boundary.callee}`, symbolId: null,
        fileId: found.boundary.fileId, line: found.boundary.line, callFileId: found.boundary.fileId,
        callLine: found.boundary.line, callee: found.boundary.callee, argCount: boundaryCall?.argCount ?? 0,
        arguments: boundaryCall?.arguments ?? "[]", params: "[]", returnType: null,
      });
      traceCount++;
    }
  }
  // 链路已经不可达时，它的叙述也不应永远留在库里；有效缓存按稳定指纹保留。
  db.prepare(
    `DELETE FROM summaries WHERE target_kind = 'trace'
       AND target_key NOT IN (SELECT fingerprint FROM traces)`,
  ).run();

  return { entries: entries.length, boundaries: boundaries.length, traces: traceCount };
}

function loadSymbols(db: Db): SymbolRow[] {
  return db.prepare(
    `SELECT s.id, s.file_id AS fileId, f.path AS filePath, f.role AS fileRole, s.name, s.container,
            s.kind, s.exported, s.start_line AS startLine, s.params, s.return_type AS returnType, s.hash
     FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE s.kind IN ('function', 'method')`,
  ).all() as SymbolRow[];
}

function loadCalls(db: Db): CallRow[] {
  return db.prepare(
    `SELECT c.id, c.file_id AS fileId, f.path AS filePath, c.caller_symbol_id AS callerId,
            c.callee_name AS callee, c.receiver, c.callee_path AS calleePath,
            c.arg_count AS argCount, c.argument_texts AS arguments, c.line
     FROM call_sites c JOIN files f ON f.id = c.file_id`,
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
 * 淹没链路列表。Node 包按 package.json 入口映射到源码，其他语言按自身的
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
      const handler = resolveHandler(symbols, call.fileId, handlerIdentifier(args.at(-1) ?? ""));
      const command = unquote(args[0]) ?? handler?.symbol.name ?? call.callee;
      out.push({
        kind: "cli", framework: cliFramework(call.callee, call.receiver),
        // 注册调用所在的外层函数不是 handler；匿名闭包没有独立符号时宁可
        // 只识别入口、不生成一条从外层初始化函数出发的假链路。
        symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
        label: `CLI ${command}`, method: null, route: null, confidence: handler?.confidence ?? "likely",
        evidence: `${call.receiver ? `${call.receiver}.` : ""}${call.callee}(command, handler) registration`,
      });
    }

    if (!HTTP_METHODS.has(method) || !call.receiver) continue;
    const route = unquote(args[0]);
    if (!route?.startsWith("/")) continue;
    const handlerName = handlerIdentifier(args.at(-1) ?? "");
    const handler = resolveHandler(symbols, call.fileId, handlerName);
    const framework = httpFramework(call.receiver, call.callee, args);
    out.push({
      kind: "http", framework, symbolId: handler?.symbol.id ?? null, fileId: call.fileId, line: call.line,
      label: `${method === "route" || method === "all" ? "HTTP" : method.toUpperCase()} ${route}`,
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

function classifyBoundary(call: CallRow): BoundaryCandidate | null {
  const callee = call.callee.toLowerCase();
  const receiver = (call.receiver ?? "").toLowerCase();
  const qualified = `${receiver}.${callee}`;
  let kind: BoundaryKind | null = null;
  let evidence = "";
  let confidence: "exact" | "likely" = "likely";

  if (/^(query|queryrow|execute|exec|transaction|findunique|findmany|findone|findall|insert|upsert|save|commit|rollback)$/.test(callee) &&
      /(^|\.|_)(db|sql|sqlx|database|pool|connection|conn|cursor|session|prisma|sequelize|knex|repository|repo|collection|model)(\.|_|$)/.test(receiver)) {
    kind = "database"; evidence = `数据库接收者 ${qualified}`; confidence = "exact";
  } else if (/^(readfile|readfilesync|writefile|writefilesync|appendfile|appendfilesync|createreadstream|createwritestream|readdir|readdirsync|mkdir|mkdirsync|unlink|unlinksync|remove|read_to_string|read_dir)$/.test(callee) ||
      (/^(open|create)$/.test(callee) && /(^|\.)(fs|file|path|os)$/.test(receiver))) {
    kind = "filesystem"; evidence = `文件系统 API ${qualified}`; confidence = "exact";
  } else if (/^(spawn|execfile|execsync|spawnsync|command|popen|system)$/.test(callee) ||
      (callee === "exec" && (receiver === "" || /child_process|command|process/.test(receiver))) ||
      (callee === "run" && /subprocess|command|process/.test(receiver)) ||
      (callee === "new" && /(^|::|\.)command$/.test(receiver))) {
    kind = "process"; evidence = `外部进程 API ${qualified}`; confidence = "exact";
  } else if (/^(publish|basic_publish|subscribe|basic_consume|sendmessage|sendmessages|receivemessage|sendtoqueue|consume|produce|enqueue|dequeue|ack|nack|xadd|lpush|rpush)$/.test(callee) &&
      /queue|kafka|rabbit|channel|sqs|pubsub|broker|producer|consumer/.test(receiver)) {
    kind = "message-queue"; evidence = `消息队列 API ${qualified}`; confidence = "exact";
  } else if (callee === "fetch" || /^(axios|got|requesturl|urlopen)$/.test(callee) ||
      (/^(get|post|put|patch|delete|send|request|do)$/.test(callee) && /http|client|axios|request|requests|url/.test(receiver))) {
    kind = "network"; evidence = `网络客户端 API ${qualified}`; confidence = callee === "fetch" ? "exact" : "likely";
  } else if (/^(get|all|run|prepare)$/.test(callee) && /(^|\.|_)(db|sql|database)(\.|_|$)/.test(receiver)) {
    kind = "database"; evidence = `数据库客户端 API ${qualified}`; confidence = "exact";
  }
  if (!kind) return null;
  return { kind, symbolId: call.callerId, fileId: call.fileId, callSiteId: call.id, line: call.line,
    callee: call.receiver ? `${call.receiver}.${call.callee}` : call.callee, confidence, evidence };
}

function loadEdges(db: Db): Map<number, CallEdge[]> {
  const rows = db.prepare(
    `SELECT src_id AS "from", dst_id AS "to", COALESCE(line, 0) AS line, confidence
     FROM edges WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
       AND confidence IN ('exact', 'likely') ORDER BY confidence, weight DESC`,
  ).all() as CallEdge[];
  const out = new Map<number, CallEdge[]>();
  for (const edge of rows) {
    const bucket = out.get(edge.from);
    if (bucket) bucket.push(edge); else out.set(edge.from, [edge]);
  }
  return out;
}

function pathsToBoundaries(
  start: number, adjacency: ReadonlyMap<number, readonly CallEdge[]>,
  boundaries: ReadonlyMap<number, readonly BoundaryCandidate[]>,
  boundaryDistance: ReadonlyMap<number, number>, maxDepth: number, maxPaths: number,
): Array<{ symbols: number[]; edges: CallEdge[]; boundary: BoundaryCandidate }> {
  const queue: Array<{ symbols: number[]; edges: CallEdge[] }> = [{ symbols: [start], edges: [] }];
  const bestDepth = new Map<number, number>([[start, 0]]);
  const out: Array<{ symbols: number[]; edges: CallEdge[]; boundary: BoundaryCandidate }> = [];
  const seenBoundary = new Set<number>();
  while (queue.length > 0 && out.length < maxPaths) {
    const path = queue.shift() as { symbols: number[]; edges: CallEdge[] };
    const current = path.symbols.at(-1) as number;
    for (const boundary of boundaries.get(current) ?? []) {
      if (seenBoundary.has(boundary.callSiteId)) continue;
      seenBoundary.add(boundary.callSiteId);
      out.push({ ...path, boundary });
      if (out.length >= maxPaths) break;
    }
    if (path.edges.length >= maxDepth) continue;
    for (const edge of adjacency.get(current) ?? []) {
      if (path.symbols.includes(edge.to)) continue;
      const depth = path.edges.length + 1;
      const distance = boundaryDistance.get(edge.to);
      if (distance === undefined || distance > maxDepth - depth) continue;
      if ((bestDepth.get(edge.to) ?? Number.POSITIVE_INFINITY) <= depth) continue;
      bestDepth.set(edge.to, depth);
      queue.push({ symbols: [...path.symbols, edge.to], edges: [...path.edges, edge] });
    }
  }
  return out;
}

/** 从边界反向扩散，裁掉深度预算内不可能到达 I/O 的入口与分支。 */
function distanceToBoundary(
  adjacency: ReadonlyMap<number, readonly CallEdge[]>,
  boundaries: ReadonlyMap<number, readonly BoundaryCandidate[]>,
  maxDepth: number,
): Map<number, number> {
  const reverse = new Map<number, number[]>();
  for (const edges of adjacency.values()) {
    for (const edge of edges) {
      const bucket = reverse.get(edge.to);
      if (bucket) bucket.push(edge.from); else reverse.set(edge.to, [edge.from]);
    }
  }
  const distance = new Map<number, number>();
  let frontier = [...boundaries.keys()];
  for (const id of frontier) distance.set(id, 0);
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const caller of reverse.get(id) ?? []) {
        if (distance.has(caller)) continue;
        distance.set(caller, depth);
        next.push(caller);
      }
    }
    frontier = next;
  }
  return distance;
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
  const out = new Map<string, EntryCandidate>();
  for (const entry of entries) {
    const key = `${entry.kind}:${entry.fileId}:${entry.line}:${entry.route ?? ""}:${entry.symbolId ?? ""}`;
    if (!out.has(key)) out.set(key, entry);
  }
  return [...out.values()];
}

function dedupeBoundaries(boundaries: BoundaryCandidate[]): BoundaryCandidate[] {
  return [...new Map(boundaries.map((boundary) => [boundary.callSiteId, boundary])).values()];
}

function indexCalls(calls: readonly CallRow[]): Map<string, CallRow[]> {
  const out = new Map<string, CallRow[]>();
  for (const call of calls) {
    if (call.callerId === null) continue;
    const key = `${call.callerId}:${call.line}`;
    const bucket = out.get(key);
    if (bucket) bucket.push(call); else out.set(key, [call]);
  }
  return out;
}

function traceFingerprint(
  entry: EntryCandidate, symbols: readonly number[], edges: readonly CallEdge[], boundary: BoundaryCandidate,
  boundaryCall: CallRow | undefined, byId: ReadonlyMap<number, SymbolRow>,
): string {
  return createHash("sha256").update(JSON.stringify({
    entry: [entry.kind, entry.method, entry.route, entry.line, entry.evidence],
    symbols: symbols.map((id) => {
      const symbol = byId.get(id);
      return symbol ? [symbol.filePath, qualifiedName(symbol), symbol.hash] : [id];
    }),
    edges: edges.map((edge) => [edge.line, edge.confidence]),
    boundary: [
      boundary.kind, boundaryCall?.filePath, boundary.callee, boundary.line, boundary.confidence,
      boundaryCall?.receiver, boundaryCall?.calleePath, boundaryCall?.arguments,
    ],
  })).digest("hex");
}

function boundaryLabel(kind: BoundaryKind): string {
  return ({ database: "数据库", network: "网络", filesystem: "文件系统", "message-queue": "消息队列", process: "外部进程" })[kind];
}

function isPresent<T>(value: T | null): value is T { return value !== null; }

/** 避免无效 JSON 把链路查询炸掉；当前只用于类型签名的防御性读取。 */
export function parseParams(raw: string | null): ParamDto[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? (value as ParamDto[]) : [];
  } catch { return []; }
}
