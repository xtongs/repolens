import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LlmConfig, LlmRunStats, SemanticResultDto, TraceNarrativeDto, TraceNarrativeResultDto } from "../types.js";
import { loadConfig } from "../config.js";
import { getMeta, setMeta, type Db, transact } from "../db/database.js";
import { symbolKey } from "../db/queries.js";
import { getTrace } from "../db/traces.js";
import { addUsage, emptyUsage, LlmUnavailableError, OpenAiCompatibleClient } from "./client.js";
import {
  getCachedSemantic,
  invalidateCachedSemantic,
  mergeLlmStatusUsage,
  putCachedSemantic,
} from "./cache.js";

interface SemanticTarget {
  kind: "package" | "directory";
  key: string;
  nodeId: string;
  hash: string;
  context: Record<string, unknown>;
}

interface BatchResponse {
  items?: Array<{ key?: unknown; summary?: unknown }>;
}

interface ArchitectureResponse {
  summary?: unknown;
  layers?: Array<{ name?: unknown; description?: unknown; nodeIds?: unknown }>;
}

interface SymbolSemanticResponse {
  summary?: unknown;
  pseudocode?: unknown;
}

interface TraceNarrativeResponse {
  summary?: unknown;
  steps?: Array<{ ordinal?: unknown; narrative?: unknown; parameterFlow?: unknown }>;
}

const inflight = new Map<string, Promise<SemanticResultDto>>();
const traceInflight = new Map<string, Promise<TraceNarrativeResultDto>>();

/** 扫描期语义增强：只碰 repo / package / directory，不预生成文件和函数。 */
export async function enrichRepository(db: Db, root: string, config: LlmConfig): Promise<LlmRunStats> {
  const started = Date.now();
  const stats: LlmRunStats = {
    enabled: config.enabled,
    available: false,
    model: config.model,
    generated: 0,
    cacheHits: 0,
    failures: 0,
    durationMs: 0,
    ...emptyUsage(),
  };

  setMeta(db, "llm_output_language", config.outputLanguage);

  // 缓存有效性只由结构指纹决定，与本次有没有 key 无关。先清过期内容，
  // 否则断网扫描后 UI 仍会展示已经与源码不一致的旧解释。
  const repoHash = repositoryHash(db);
  const architectureNodes = architectureCandidates(db);
  const architectureHash = digest([repoHash, architectureNodes, config.outputLanguage, config.model]);
  const cachedRepo = getCachedSemantic(
    db, "repo", ".", "summary", config.outputLanguage, repoHash, config.model,
  );
  const cachedLayers = layersAreFresh(db, architectureHash);
  const targets = semanticTargets(db);
  const missing: SemanticTarget[] = [];
  transact(db, () => {
    invalidateCachedSemantic(db, "repo", ".", repoHash);
    if (!cachedLayers) db.prepare("DELETE FROM layers").run();
    for (const target of targets) {
      const cached = getCachedSemantic(
        db, target.kind, target.key, "summary", config.outputLanguage, target.hash, config.model,
      );
      if (cached) stats.cacheHits++;
      else {
        invalidateCachedSemantic(db, target.kind, target.key, target.hash);
        missing.push(target);
      }
    }
  });
  if (cachedRepo) stats.cacheHits++;
  if (cachedLayers) stats.cacheHits++;

  if (!config.enabled) {
    stats.reason = "LLM 已关闭，使用纯结构模式";
    finishScanStatus(db, stats, started, config.interactiveModel);
    return stats;
  }

  let client: OpenAiCompatibleClient;
  try {
    client = new OpenAiCompatibleClient(config);
    stats.available = true;
  } catch (err) {
    stats.reason = safeMessage(err);
    finishScanStatus(db, stats, started, config.interactiveModel);
    return stats;
  }

  let remainingCalls = config.scanMaxCalls;
  const jobs: Array<() => Promise<void>> = [];

  if ((!cachedRepo || !cachedLayers) && remainingCalls > 0) {
    remainingCalls--;
    jobs.push(async () => {
      try {
        const result = await client.completeJson<ArchitectureResponse>(
          architectureSystem(config.outputLanguage),
          JSON.stringify({
            repository: repositoryContext(db),
            allowedNodes: architectureNodes,
          }),
        );
        addUsage(stats, result.usage);
        const summary = cleanText(result.data.summary, 2_000);
        const layers = cleanLayers(result.data.layers, new Set(architectureNodes.map((n) => n.id)));
        transact(db, () => {
          if (summary !== null) {
            putCachedSemantic(db, {
              targetKind: "repo",
              targetKey: ".",
              flavor: "summary",
              lang: config.outputLanguage,
              content: summary,
              sourceHash: repoHash,
              model: config.model,
            });
            stats.generated++;
          }
          if (layers.length > 0) {
            db.prepare("DELETE FROM layers").run();
            const insert = db.prepare(
              `INSERT INTO layers (name, description, ordinal, members, source_hash, model, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
            );
            for (const [ordinal, layer] of layers.entries()) {
              insert.run(
                layer.name,
                layer.description,
                ordinal,
                JSON.stringify(layer.nodeIds),
                architectureHash,
                config.model,
                new Date().toISOString(),
              );
            }
            stats.generated += layers.length;
          }
        });
      } catch (err) {
        stats.failures++;
        stats.reason ??= safeMessage(err);
      }
    });
  }

  // 尽量覆盖全部目标，同时坚守 scanMaxCalls；超大仓库会自动增大每批数量。
  const batchSize = Math.min(
    20,
    Math.max(config.scanBatchSize, Math.ceil(missing.length / Math.max(1, remainingCalls))),
  );
  for (let start = 0; start < missing.length && remainingCalls > 0; start += batchSize) {
    const batch = missing.slice(start, start + batchSize);
    remainingCalls--;
    jobs.push(async () => {
      try {
        const result = await client.completeJson<BatchResponse>(
          summarySystem(config.outputLanguage),
          JSON.stringify({ items: batch.map((item) => ({ key: item.key, ...item.context })) }),
        );
        addUsage(stats, result.usage);
        const byKey = new Map(
          (result.data.items ?? [])
            .map((item) => [typeof item.key === "string" ? item.key : "", cleanText(item.summary, 600)] as const)
            .filter((entry): entry is readonly [string, string] => entry[0] !== "" && entry[1] !== null),
        );
        transact(db, () => {
          for (const target of batch) {
            const summary = byKey.get(target.key);
            if (!summary) continue;
            putCachedSemantic(db, {
              targetKind: target.kind,
              targetKey: target.key,
              flavor: "summary",
              lang: config.outputLanguage,
              content: summary,
              sourceHash: target.hash,
              model: config.model,
            });
            stats.generated++;
          }
        });
      } catch (err) {
        stats.failures++;
        stats.reason ??= safeMessage(err);
      }
    });
  }

  await Promise.all(jobs.map((job) => job()));
  if (jobs.length > 0 && stats.failures === jobs.length) {
    stats.available = false;
  }
  finishScanStatus(db, stats, started, config.interactiveModel);
  return stats;
}

/** 详情抽屉触发：同一次生成同时拿摘要和伪代码，并按符号源码 hash 缓存。 */
export async function generateSymbolSemantics(
  db: Db,
  root: string,
  symbolId: number,
  options: { force?: boolean } = {},
): Promise<SemanticResultDto> {
  const force = options.force === true;
  const key = `${root}:symbol:${symbolId}:${force ? "force" : "cached"}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = generateSymbolSemanticsInner(db, root, symbolId, force).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

async function generateSymbolSemanticsInner(
  db: Db,
  root: string,
  symbolId: number,
  force: boolean,
): Promise<SemanticResultDto> {
  const config = loadConfig(root).llm;
  const row = db
    .prepare(
      `SELECT s.name, s.kind, s.container, s.signature, s.doc, s.hash, s.start_byte AS startByte,
              s.end_byte AS endByte, s.start_line AS startLine, s.end_line AS endLine,
              f.path AS filePath, f.language
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    )
    .get(symbolId) as
    | {
        name: string; kind: string; container: string | null; signature: string | null;
        doc: string | null; hash: string; startByte: number; endByte: number;
        startLine: number; endLine: number; filePath: string; language: string;
      }
    | undefined;
  if (!row) throw new Error("符号不存在");

  const targetKey = symbolKey(row.filePath, row.container, row.name, row.startLine);
  const lang = config.outputLanguage;
  const requestConfig = interactiveConfig(config);
  const summary = getCachedSemantic(
    db, "symbol", targetKey, "summary-v2", lang, row.hash, requestConfig.model,
  );
  const pseudocode = getCachedSemantic(
    db, "symbol", targetKey, "pseudocode", lang, row.hash, requestConfig.model,
  );
  if (!force && summary && pseudocode) {
    return {
      summary: summary.content,
      pseudocode: pseudocode.content,
      generated: false,
      cacheHit: true,
      model: summary.model,
      usage: emptyUsage(),
    };
  }

  const client = new OpenAiCompatibleClient(requestConfig);
  const source = readSymbolSource(root, row.filePath, row.startByte, row.endByte);
  const relations = symbolRelations(db, symbolId);
  const result = await client.completeJson<SymbolSemanticResponse>(
    symbolSystem(config.outputLanguage),
    JSON.stringify({
      symbol: {
        name: row.container ? `${row.container}.${row.name}` : row.name,
        kind: row.kind,
        language: row.language,
        file: row.filePath,
        lines: [row.startLine, row.endLine],
        signature: row.signature,
        documentation: row.doc,
        callers: relations.callers,
        callees: relations.callees,
        source,
      },
    }),
    { maxOutputTokens: 900 },
  );
  const generatedSummary = cleanText(result.data.summary, 2_000);
  const generatedPseudocode = cleanText(result.data.pseudocode, 8_000);
  if (generatedSummary === null || generatedPseudocode === null) {
    throw new Error("LLM 返回缺少 summary 或 pseudocode");
  }

  transact(db, () => {
    invalidateCachedSemantic(db, "symbol", targetKey, row.hash);
    for (const [flavor, content] of [
      ["summary-v2", generatedSummary],
      ["pseudocode", generatedPseudocode],
    ] as const) {
      putCachedSemantic(db, {
        targetKind: "symbol",
        targetKey,
        flavor,
        lang,
        content,
        sourceHash: row.hash,
        model: requestConfig.model,
      });
    }
    mergeLlmStatusUsage(db, {
      enabled: true,
      available: true,
      model: config.model,
      interactiveModel: config.interactiveModel,
      reason: null,
      usage: result.usage,
    });
  });

  return {
    summary: generatedSummary,
    pseudocode: generatedPseudocode,
    generated: true,
    cacheHit: false,
    model: requestConfig.model,
    usage: result.usage,
  };
}

/** 文件摘要同样按需，保证扫描期仍然只有包/目录级请求。 */
export async function generateFileSummary(
  db: Db,
  root: string,
  fileId: number,
  options: { force?: boolean } = {},
): Promise<SemanticResultDto> {
  const force = options.force === true;
  const key = `${root}:file:${fileId}:${force ? "force" : "cached"}`;
  const pending = inflight.get(key);
  if (pending) return pending;
  const task = generateFileSummaryInner(db, root, fileId, force).finally(() => inflight.delete(key));
  inflight.set(key, task);
  return task;
}

/** 链路事实已经确定后才调用 LLM；模型只负责逐步叙述，不得改写步骤或置信度。 */
export async function generateTraceNarrative(
  db: Db,
  root: string,
  traceId: number,
): Promise<TraceNarrativeResultDto> {
  const key = `${root}:trace:${traceId}`;
  const pending = traceInflight.get(key);
  if (pending) return pending;
  const task = generateTraceNarrativeInner(db, root, traceId).finally(() => traceInflight.delete(key));
  traceInflight.set(key, task);
  return task;
}

async function generateTraceNarrativeInner(
  db: Db, root: string, traceId: number,
): Promise<TraceNarrativeResultDto> {
  const config = loadConfig(root).llm;
  const requestConfig = interactiveConfig(config);
  const trace = getTrace(db, traceId);
  if (!trace) throw new Error("链路不存在");
  const cached = getCachedSemantic(
    db, "trace", trace.fingerprint, "narrative", config.outputLanguage, trace.fingerprint, requestConfig.model,
  );
  if (cached) {
    const narrative = parseTraceNarrative(cached.content, trace.orderedSteps.map((step) => step.ordinal));
    if (narrative) {
      return { narrative, generated: false, cacheHit: true, model: cached.model, usage: emptyUsage() };
    }
  }

  const client = new OpenAiCompatibleClient(requestConfig);
  const result = await client.completeJson<TraceNarrativeResponse>(
    traceSystem(config.outputLanguage),
    JSON.stringify({
      trace: {
        label: trace.label, entry: trace.entry, boundary: trace.boundary,
        steps: trace.orderedSteps.map((step) => ({
          ordinal: step.ordinal, kind: step.kind, source: step.source, confidence: step.confidence,
          label: step.label, file: step.filePath, line: step.line, callSite: step.callSite,
          argCount: step.argCount, arguments: step.arguments, params: step.params, returnType: step.returnType,
        })),
        signatureTypeFlows: trace.typeFlows,
      },
    }),
    { maxOutputTokens: 900 },
  );
  const narrative = cleanTraceNarrative(result.data, trace.orderedSteps.map((step) => step.ordinal));
  if (!narrative) throw new Error("LLM 返回的链路叙述不完整");

  transact(db, () => {
    invalidateCachedSemantic(db, "trace", trace.fingerprint, trace.fingerprint);
    putCachedSemantic(db, {
      targetKind: "trace", targetKey: trace.fingerprint, flavor: "narrative",
      lang: config.outputLanguage, content: JSON.stringify(narrative),
      sourceHash: trace.fingerprint, model: requestConfig.model,
    });
    mergeLlmStatusUsage(db, {
      enabled: true, available: true, model: config.model, interactiveModel: config.interactiveModel,
      reason: null, usage: result.usage,
    });
  });
  return { narrative, generated: true, cacheHit: false, model: requestConfig.model, usage: result.usage };
}

async function generateFileSummaryInner(
  db: Db, root: string, fileId: number, force: boolean,
): Promise<SemanticResultDto> {
  const config = loadConfig(root).llm;
  const row = db.prepare("SELECT path, language, hash FROM files WHERE id = ?").get(fileId) as
    | { path: string; language: string; hash: string }
    | undefined;
  if (!row) throw new Error("文件不存在");
  const cached = getCachedSemantic(
    db, "file", row.path, "summary-v2", config.outputLanguage, row.hash,
    interactiveConfig(config).model,
  );
  if (!force && cached) {
    return { summary: cached.content, generated: false, cacheHit: true, model: cached.model, usage: emptyUsage() };
  }

  const requestConfig = interactiveConfig(config);
  const client = new OpenAiCompatibleClient(requestConfig);
  const symbols = db.prepare(
    "SELECT name, kind, signature, doc FROM symbols WHERE file_id = ? ORDER BY start_line LIMIT 80",
  ).all(fileId);
  const imports = db.prepare(
    "SELECT raw_source AS source FROM imports WHERE file_id = ? ORDER BY line LIMIT 80",
  ).all(fileId);
  const source = readFileCapped(root, row.path, 24_000);
  const result = await client.completeJson<{ summary?: unknown }>(
    fileSystem(config.outputLanguage),
    JSON.stringify({ file: { path: row.path, language: row.language, symbols, imports, source } }),
  );
  const generatedSummary = cleanText(result.data.summary, 2_000);
  if (generatedSummary === null) throw new Error("LLM 返回缺少 summary");
  transact(db, () => {
    invalidateCachedSemantic(db, "file", row.path, row.hash);
    putCachedSemantic(db, {
      targetKind: "file", targetKey: row.path, flavor: "summary-v2",
      lang: config.outputLanguage, content: generatedSummary, sourceHash: row.hash, model: requestConfig.model,
    });
    mergeLlmStatusUsage(db, {
      enabled: true, available: true, model: config.model,
      interactiveModel: config.interactiveModel, reason: null, usage: result.usage,
    });
  });
  return { summary: generatedSummary, generated: true, cacheHit: false, model: requestConfig.model, usage: result.usage };
}

function semanticTargets(db: Db): SemanticTarget[] {
  const packages = db.prepare(
    `SELECT p.name, p.dir, p.manager, COUNT(f.id) AS files, COALESCE(SUM(f.loc), 0) AS loc
     FROM packages p LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
     GROUP BY p.id HAVING files > 0 ORDER BY loc DESC`,
  ).all() as Array<{ name: string; dir: string; manager: string; files: number; loc: number }>;
  const packageTargets = packages.map((row): SemanticTarget => {
    const fileRows = filesUnder(db, row.dir, 30);
    return {
      kind: "package", key: row.name, nodeId: `pkg:${row.name}`,
      hash: targetHash(db, row.dir),
      context: { kind: "package", path: row.dir, manager: row.manager, files: row.files, loc: row.loc, examples: fileRows },
    };
  });

  const directories = db.prepare(
    `SELECT d.path, d.loc, d.file_count AS files, d.symbol_count AS symbols
     FROM directories d
     WHERE EXISTS (SELECT 1 FROM files f WHERE f.role = 'source' AND (f.dir_path = d.path OR f.path LIKE d.path || '/%'))
     ORDER BY d.loc DESC`,
  ).all() as Array<{ path: string; loc: number; files: number; symbols: number }>;
  const directoryTargets = directories.map((row): SemanticTarget => ({
    kind: "directory", key: row.path, nodeId: `dir:${row.path}`,
    hash: targetHash(db, row.path),
    context: { kind: "directory", path: row.path, files: row.files, loc: row.loc, symbols: row.symbols, examples: filesUnder(db, row.path, 20) },
  }));
  return [...packageTargets, ...directoryTargets];
}

function filesUnder(db: Db, dir: string, limit: number): unknown[] {
  const root = dir === ".";
  return db.prepare(
    `SELECT f.path, f.language, f.loc,
            (SELECT GROUP_CONCAT(name, ', ') FROM (SELECT s.name FROM symbols s WHERE s.file_id = f.id ORDER BY s.exported DESC, s.start_line LIMIT 8)) AS symbols
     FROM files f WHERE f.role = 'source' AND ${root ? "1 = 1" : "(f.dir_path = ? OR f.path LIKE ? || '/%')"}
     ORDER BY f.loc DESC LIMIT ?`,
  ).all(...(root ? [limit] : [dir, dir, limit]));
}

function targetHash(db: Db, dir: string): string {
  const root = dir === ".";
  const rows = db.prepare(
    `SELECT path, hash FROM files WHERE role = 'source' AND ${root ? "1 = 1" : "(dir_path = ? OR path LIKE ? || '/%')"} ORDER BY path`,
  ).all(...(root ? [] : [dir, dir])) as Array<{ path: string; hash: string }>;
  return digest(rows);
}

function repositoryHash(db: Db): string {
  return targetHash(db, ".");
}

function repositoryContext(db: Db): Record<string, unknown> {
  const totals = db.prepare(
    "SELECT COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc FROM files WHERE role = 'source'",
  ).get();
  const languages = db.prepare(
    "SELECT language, COUNT(*) AS files, SUM(loc) AS loc FROM files WHERE role = 'source' GROUP BY language ORDER BY loc DESC",
  ).all();
  const packages = db.prepare(
    `SELECT p.name, p.dir, COUNT(f.id) AS files, COALESCE(SUM(f.loc), 0) AS loc
     FROM packages p LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source' GROUP BY p.id ORDER BY loc DESC`,
  ).all();
  return { name: getMeta(db, "repo_name"), totals, languages, packages };
}

function architectureCandidates(db: Db): Array<{ id: string; label: string; path: string }> {
  const packages = db.prepare(
    `SELECT p.name, p.dir, COUNT(f.id) AS files FROM packages p
     LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
     GROUP BY p.id HAVING files > 0 ORDER BY files DESC`,
  ).all() as Array<{ name: string; dir: string; files: number }>;
  if (packages.length >= 2) return packages.map((p) => ({ id: `pkg:${p.name}`, label: p.name, path: p.dir }));
  return (db.prepare(
    "SELECT path, name AS label FROM directories WHERE depth = 1 AND file_count > 0 ORDER BY loc DESC LIMIT 100",
  ).all() as Array<{ path: string; label: string }>).map((d) => ({ id: `dir:${d.path}`, label: d.label, path: d.path }));
}

function layersAreFresh(db: Db, hash: string): boolean {
  const row = db.prepare("SELECT COUNT(*) AS n, MIN(source_hash = ?) AS fresh FROM layers").get(hash) as { n: number; fresh: number | null };
  return row.n > 0 && row.fresh === 1;
}

function symbolRelations(db: Db, symbolId: number): { callers: string[]; callees: string[] } {
  const query = (direction: "callers" | "callees") =>
    (db.prepare(direction === "callers"
      ? `SELECT s.name, f.path FROM edges e JOIN symbols s ON s.id = e.src_id JOIN files f ON f.id = s.file_id
         WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol' AND e.dst_id = ? LIMIT 30`
      : `SELECT s.name, f.path FROM edges e JOIN symbols s ON s.id = e.dst_id JOIN files f ON f.id = s.file_id
         WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol' AND e.src_id = ? LIMIT 30`)
      .all(symbolId) as Array<{ name: string; path: string }>).map((row) => `${row.name} (${row.path})`);
  return { callers: query("callers"), callees: query("callees") };
}

function readSymbolSource(root: string, path: string, startByte: number, endByte: number): string {
  try {
    const bytes = readFileSync(join(root, path));
    return bytes.subarray(startByte, Math.min(endByte, startByte + 40_000)).toString("utf8");
  } catch {
    return "";
  }
}

function readFileCapped(root: string, path: string, maxChars: number): string {
  try {
    return readFileSync(join(root, path), "utf8").slice(0, maxChars);
  } catch {
    return "";
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = decodeHtmlEntities(value)
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .trim();
  return text === "" ? null : text.slice(0, maxLength);
}

/**
 * 模型偶尔会把普通文本写成 HTML 实体。前端按文本渲染，不应把 `&#x20;`
 * 这样的传输噪音展示给用户；这里只解码明确的字符实体，不解析 HTML。
 */
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  };
  return value
    .replace(/&#(?:x([0-9a-f]+)|([0-9]+));/gi, (entity, hex: string | undefined, decimal: string | undefined) => {
      const codePoint = Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16);
      return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff &&
        !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : entity;
    })
    .replace(/&(nbsp|amp|lt|gt|quot|apos);/gi, (entity, name: string) => named[name.toLowerCase()] ?? entity);
}

function cleanLayers(
  input: ArchitectureResponse["layers"],
  allowed: ReadonlySet<string>,
): Array<{ name: string; description: string; nodeIds: string[] }> {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: Array<{ name: string; description: string; nodeIds: string[] }> = [];
  for (const raw of input.slice(0, 12)) {
    const name = cleanText(raw.name, 80);
    if (!name || seen.has(name)) continue;
    const nodeIds = Array.isArray(raw.nodeIds)
      ? [...new Set(raw.nodeIds.filter((id): id is string => typeof id === "string" && allowed.has(id)))]
      : [];
    if (nodeIds.length === 0) continue;
    seen.add(name);
    out.push({ name, description: cleanText(raw.description, 400) ?? "", nodeIds });
  }
  return out;
}

function finishScanStatus(
  db: Db,
  stats: LlmRunStats,
  started: number,
  interactiveModel: string | null,
): void {
  stats.durationMs = Date.now() - started;
  mergeLlmStatusUsage(db, {
    enabled: stats.enabled, available: stats.available, model: stats.model,
    interactiveModel,
    reason: stats.reason ?? null,
    usage: { requests: stats.requests, inputTokens: stats.inputTokens, outputTokens: stats.outputTokens, totalTokens: stats.totalTokens },
  });
}

function safeMessage(error: unknown): string {
  if (error instanceof LlmUnavailableError || error instanceof Error) return error.message.slice(0, 500);
  return String(error).slice(0, 500);
}

function interactiveConfig(config: LlmConfig): LlmConfig {
  return config.interactiveModel === null
    ? config
    : { ...config, model: config.interactiveModel };
}

function languageName(lang: "zh" | "en"): string {
  return lang === "zh" ? "简体中文" : "English";
}

function architectureSystem(lang: "zh" | "en"): string {
  return `你是代码架构分析器。只依据输入的确定性结构数据归纳语义，不得编造调用关系。用${languageName(lang)}输出。` +
    `只返回 JSON：{"summary":"仓库概览（2-4句）","layers":[{"name":"层名","description":"一句说明","nodeIds":["只能来自 allowedNodes.id"]}]}。` +
    `每个节点最多属于一个主层；无法判断的节点可不分层。`;
}

function summarySystem(lang: "zh" | "en"): string {
  return `你是代码仓库摘要器。根据路径、语言、指标和代表性符号，为每个包或目录写一句准确说明。用${languageName(lang)}输出。` +
    `不得推断输入中没有的业务事实。只返回 JSON：{"items":[{"key":"原样复制输入 key","summary":"一句话"}]}。`;
}

function symbolSystem(lang: "zh" | "en"): string {
  return `你是代码解释器。只根据给定源码、签名和确定性调用关系解释符号。用${languageName(lang)}输出。` +
    readableSummaryInstructions(lang, false) +
    `只返回 JSON：{"summary":"带有段落换行的摘要","pseudocode":"逻辑伪代码"}。` +
    `伪代码最多 12 行，不要复述语法，要呈现分支、循环、错误处理、输入输出；不得声称源码被截断。`;
}

function fileSystem(lang: "zh" | "en"): string {
  return `你是代码文件摘要器。只根据给定源码、导入和符号列表解释文件。用${languageName(lang)}输出。` +
    readableSummaryInstructions(lang, true) +
    `不得编造源码中没有的业务用途、运行效果或约束。只返回 JSON：{"summary":"带有段落换行的摘要"}。`;
}

function readableSummaryInstructions(lang: "zh" | "en", requireConcepts: boolean): string {
  const structure = lang === "zh"
    ? `用 3-4 个短段落，段落之间用 \n\n 分隔：` +
      `「用途：」先用日常语言说明它解决什么问题、谁会在什么情况下使用；` +
      `「核心概念：」用“术语（通俗解释）”说明理解代码所需的 1-4 个领域术语；` +
      `「工作方式：」说明关键输入、输出和主要流程；` +
      `有重要限制、替代实现或易错边界时，再写「使用提示：」，否则省略。`
    : `Use 3-4 short paragraphs separated by \n\n: ` +
      `"Purpose:" explains in plain language what problem it solves and when someone uses it; ` +
      `"Key concepts:" defines 1-4 necessary domain terms as "term (plain explanation)"; ` +
      `"How it works:" covers important inputs, outputs, and flow; ` +
      `add "Usage notes:" only for meaningful constraints, alternatives, or pitfalls.`;
  if (lang === "en") {
    return `Write for developers who can code but are unfamiliar with this domain. ${structure}` +
      `Explain why it is needed before how it is implemented. Do not list every export or pack concepts into one long sentence. ` +
      `Do not begin with unexplained jargon; define every specialized term in parentheses at its first use. ` +
      `Derive every claim from the input, not from general knowledge of the domain. Do not imply timing, persistence, ` +
      `network reporting, runtime validation, or other behavior unless the source explicitly implements it. ` +
      (requireConcepts
        ? `Keep the Key concepts paragraph; if there is little domain jargon, explain the most important code concept. `
        : `For a simple symbol with no domain jargon, the Key concepts paragraph may be omitted. `);
  }
  return `面向会写代码、但不了解当前领域的开发者。${structure}` +
    `先讲“为什么需要”，再讲“如何实现”；不要罗列全部导出名，也不要用一句长句堆砌概念。` +
    `第一段不要直接使用未解释的专业术语；任何专业术语首次出现时都要紧跟括号解释。` +
    `每项结论都必须来自输入，不能套用该领域的一般知识。除非源码明确实现，否则不要暗示耗时统计、` +
    `持久化、网络上报、运行时校验或其他能力。` +
    (requireConcepts
      ? `必须保留核心概念段；如果几乎没有领域术语，就解释最关键的代码概念。`
      : `符号很简单且没有领域术语时，可以省略核心概念段。`);
}

function traceSystem(lang: "zh" | "en"): string {
  return `你是代码执行链路解释器。用${languageName(lang)}叙述输入中已经确定的静态链路。` +
    `不得增加、删除、重排步骤，不得把 inferred 说成运行时事实；参数流只能依据 arguments、params、returnType。` +
    `只返回 JSON：{"summary":"2-4句总览","steps":[{"ordinal":0,"narrative":"该步作用","parameterFlow":"关键参数如何进入/离开；无则空字符串"}]}。`;
}

function cleanTraceNarrative(
  input: TraceNarrativeResponse, allowedOrdinals: readonly number[],
): TraceNarrativeDto | null {
  const summary = cleanText(input.summary, 2_000);
  if (!summary || !Array.isArray(input.steps)) return null;
  const allowed = new Set(allowedOrdinals);
  const byOrdinal = new Map<number, TraceNarrativeDto["steps"][number]>();
  for (const raw of input.steps) {
    if (typeof raw.ordinal !== "number" || !allowed.has(raw.ordinal) || byOrdinal.has(raw.ordinal)) continue;
    const narrative = cleanText(raw.narrative, 1_000);
    if (!narrative) continue;
    byOrdinal.set(raw.ordinal, {
      ordinal: raw.ordinal, narrative, parameterFlow: cleanText(raw.parameterFlow, 1_000),
    });
  }
  if (allowedOrdinals.some((ordinal) => !byOrdinal.has(ordinal))) return null;
  return { summary, steps: allowedOrdinals.map((ordinal) => byOrdinal.get(ordinal) as TraceNarrativeDto["steps"][number]) };
}

function parseTraceNarrative(raw: string, ordinals: readonly number[]): TraceNarrativeDto | null {
  try { return cleanTraceNarrative(JSON.parse(raw) as TraceNarrativeResponse, ordinals); }
  catch { return null; }
}
