import type {
  BoundaryDto, BoundaryKind, EntryPointDto, ParamDto, TraceDto, TraceNarrativeDto,
  TraceStepDto, TraceSummaryDto, TraceTypeFlowDto,
} from "../types.js";
import { semanticLanguage } from "../llm/cache.js";
import type { Db } from "./database.js";

interface EntryRow {
  id: number; kind: EntryPointDto["kind"]; framework: string | null; symbolId: number | null; fileId: number;
  filePath: string; fileRole: EntryPointDto["fileRole"]; line: number; label: string; method: string | null; route: string | null;
  confidence: "exact" | "likely"; evidence: string; traceCount: number;
}

interface BoundaryRow {
  id: number; kind: BoundaryKind; symbolId: number | null; fileId: number; filePath: string; line: number;
  callee: string; confidence: "exact" | "likely"; evidence: string;
}

export function getEntryPoints(db: Db): EntryPointDto[] {
  return (db.prepare(
    `SELECT e.id, e.kind, e.framework, e.symbol_id AS symbolId, e.file_id AS fileId, f.path AS filePath,
            f.role AS fileRole,
            e.line, e.label, e.method, e.route, e.confidence, e.evidence,
            (SELECT COUNT(*) FROM traces t WHERE t.entry_id = e.id) AS traceCount
     FROM entry_points e JOIN files f ON f.id = e.file_id
     ORDER BY CASE WHEN traceCount > 0 THEN 0 ELSE 1 END,
              CASE e.kind WHEN 'http' THEN 0 WHEN 'cli' THEN 1 WHEN 'main' THEN 2
                   WHEN 'public-api' THEN 3 WHEN 'test' THEN 4 ELSE 5 END,
              traceCount DESC, e.label, f.path, e.line`,
  ).all() as EntryRow[]).map(entryDto);
}

export function getTraceSummaries(db: Db, entryId?: number): TraceSummaryDto[] {
  const where = entryId === undefined ? "" : "WHERE t.entry_id = ?";
  const rows = db.prepare(
    `SELECT t.id, t.entry_id AS entryId, t.boundary_id AS boundaryId, t.label, t.confidence,
            b.kind AS boundaryKind, COUNT(ts.id) AS steps,
            EXISTS(SELECT 1 FROM summaries sm WHERE sm.target_kind = 'trace'
              AND sm.target_key = t.fingerprint AND sm.flavor = 'narrative'
              AND sm.lang = ? AND sm.source_hash = t.fingerprint) AS hasNarrative
     FROM traces t JOIN boundaries b ON b.id = t.boundary_id
     LEFT JOIN trace_steps ts ON ts.trace_id = t.id ${where}
     GROUP BY t.id ORDER BY t.entry_id, steps, t.id`,
  ).all(...(entryId === undefined ? [semanticLanguage(db)] : [semanticLanguage(db), entryId])) as Array<{
    id: number; entryId: number; boundaryId: number; label: string; confidence: "exact" | "likely";
    boundaryKind: BoundaryKind; steps: number; hasNarrative: number;
  }>;
  return rows.map((row) => ({
    id: `trace:${row.id}`, entryId: `entry:${row.entryId}`, boundaryId: `boundary:${row.boundaryId}`,
    label: row.label, boundaryKind: row.boundaryKind, steps: row.steps, confidence: row.confidence,
    hasNarrative: row.hasNarrative === 1,
  }));
}

export function getTrace(db: Db, traceId: number): TraceDto | null {
  const trace = db.prepare(
    `SELECT t.id, t.entry_id AS entryId, t.boundary_id AS boundaryId, t.label, t.confidence, t.fingerprint,
            b.kind AS boundaryKind
     FROM traces t JOIN boundaries b ON b.id = t.boundary_id WHERE t.id = ?`,
  ).get(traceId) as { id: number; entryId: number; boundaryId: number; label: string;
    confidence: "exact" | "likely"; fingerprint: string; boundaryKind: BoundaryKind } | undefined;
  if (!trace) return null;

  const entry = db.prepare(
    `SELECT e.id, e.kind, e.framework, e.symbol_id AS symbolId, e.file_id AS fileId, f.path AS filePath,
            f.role AS fileRole,
            e.line, e.label, e.method, e.route, e.confidence, e.evidence,
            (SELECT COUNT(*) FROM traces x WHERE x.entry_id = e.id) AS traceCount
     FROM entry_points e JOIN files f ON f.id = e.file_id WHERE e.id = ?`,
  ).get(trace.entryId) as EntryRow | undefined;
  const boundary = db.prepare(
    `SELECT b.id, b.kind, b.symbol_id AS symbolId, b.file_id AS fileId, f.path AS filePath,
            b.line, b.callee, b.confidence, b.evidence
     FROM boundaries b JOIN files f ON f.id = b.file_id WHERE b.id = ?`,
  ).get(trace.boundaryId) as BoundaryRow | undefined;
  if (!entry || !boundary) return null;

  const rows = db.prepare(
    `SELECT ts.ordinal, ts.kind, ts.source, ts.confidence, ts.label, ts.symbol_id AS symbolId,
            ts.file_id AS fileId, f.path AS filePath, ts.line, ts.callee, ts.arguments, ts.params,
            ts.call_file_id AS callFileId, cf.path AS callFilePath, ts.call_line AS callLine,
            ts.arg_count AS argCount, ts.return_type AS returnType
     FROM trace_steps ts JOIN files f ON f.id = ts.file_id
     LEFT JOIN files cf ON cf.id = ts.call_file_id
     WHERE ts.trace_id = ? ORDER BY ts.ordinal`,
  ).all(traceId) as Array<{ ordinal: number; kind: TraceStepDto["kind"]; source: TraceStepDto["source"];
    confidence: "exact" | "likely"; label: string; symbolId: number | null; fileId: number; filePath: string;
    line: number; callFileId: number | null; callFilePath: string | null; callLine: number | null;
    callee: string | null; argCount: number; arguments: string; params: string; returnType: string | null }>;
  const orderedSteps: TraceStepDto[] = rows.map((row) => ({
    ordinal: row.ordinal, kind: row.kind, source: row.source, confidence: row.confidence, label: row.label,
    symbolId: row.symbolId === null ? null : `sym:${row.symbolId}`, fileId: `file:${row.fileId}`,
    filePath: row.filePath, line: row.line, callee: row.callee,
    callSite: row.callFileId === null || row.callFilePath === null || row.callLine === null ? null : {
      fileId: `file:${row.callFileId}`, filePath: row.callFilePath, line: row.callLine,
    },
    argCount: row.argCount, arguments: parseStringArray(row.arguments),
    params: parseParams(row.params), returnType: row.returnType,
  }));
  const narrative = readNarrative(db, trace.fingerprint);
  return {
    id: `trace:${trace.id}`, entryId: `entry:${trace.entryId}`, boundaryId: `boundary:${trace.boundaryId}`,
    label: trace.label, boundaryKind: trace.boundaryKind, steps: orderedSteps.length, confidence: trace.confidence,
    hasNarrative: narrative !== null, fingerprint: trace.fingerprint, entry: entryDto(entry),
    boundary: boundaryDto(boundary), orderedSteps, typeFlows: inferTypeFlows(orderedSteps), narrative,
  };
}

function entryDto(row: EntryRow): EntryPointDto {
  return { id: `entry:${row.id}`, kind: row.kind, framework: row.framework,
    symbolId: row.symbolId === null ? null : `sym:${row.symbolId}`, fileId: `file:${row.fileId}`,
    filePath: row.filePath, fileRole: row.fileRole, line: row.line, label: row.label, method: row.method, route: row.route,
    confidence: row.confidence, evidence: row.evidence, traceCount: row.traceCount };
}

function boundaryDto(row: BoundaryRow): BoundaryDto {
  return { id: `boundary:${row.id}`, kind: row.kind, symbolId: row.symbolId === null ? null : `sym:${row.symbolId}`,
    fileId: `file:${row.fileId}`, filePath: row.filePath, line: row.line, callee: row.callee,
    confidence: row.confidence, evidence: row.evidence };
}

function inferTypeFlows(steps: readonly TraceStepDto[]): TraceTypeFlowDto[] {
  const byType = new Map<string, TraceTypeFlowDto["through"]>();
  for (const step of steps) {
    for (const param of step.params) addType(byType, param.type, step, "parameter");
    addType(byType, step.returnType, step, "return");
  }
  return [...byType.entries()]
    .map(([type, through]) => ({ type, source: "inferred" as const, through }))
    .sort((a, b) => b.through.length - a.through.length || a.type.localeCompare(b.type));
}

function addType(
  target: Map<string, TraceTypeFlowDto["through"]>, raw: string | null | undefined,
  step: TraceStepDto, role: "parameter" | "return",
): void {
  const type = normalizeType(raw);
  if (!type) return;
  const item = { ordinal: step.ordinal, symbolId: step.symbolId, label: step.label, role };
  const bucket = target.get(type);
  if (bucket) {
    if (!bucket.some((found) => found.ordinal === item.ordinal && found.role === item.role)) bucket.push(item);
  } else target.set(type, [item]);
}

function normalizeType(value: string | null | undefined): string | null {
  const type = value?.trim().replace(/^:\s*/, "").replace(/\s+/g, " ");
  if (!type || /^(void|none|nil|unknown|any|self|\(\))$/i.test(type)) return null;
  return type.slice(0, 160);
}

function readNarrative(db: Db, fingerprint: string): TraceNarrativeDto | null {
  const row = db.prepare(
    `SELECT content FROM summaries WHERE target_kind = 'trace' AND target_key = ?
       AND flavor = 'narrative' AND lang = ? AND source_hash = ? ORDER BY created_at DESC LIMIT 1`,
  ).get(fingerprint, semanticLanguage(db), fingerprint) as { content: string } | undefined;
  if (!row) return null;
  try {
    const value = JSON.parse(row.content) as TraceNarrativeDto;
    return typeof value.summary === "string" && Array.isArray(value.steps) ? value : null;
  } catch { return null; }
}

function parseStringArray(raw: string): string[] {
  try { const value = JSON.parse(raw) as unknown; return Array.isArray(value) ? value.filter((x): x is string => typeof x === "string") : []; }
  catch { return []; }
}

function parseParams(raw: string): ParamDto[] {
  try { const value = JSON.parse(raw) as unknown; return Array.isArray(value) ? (value as ParamDto[]) : []; }
  catch { return []; }
}
