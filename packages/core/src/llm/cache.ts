import type { LlmUsage } from "../types.js";
import { getMeta, getMetaJson, setMetaJson, type Db } from "../db/database.js";
import { emptyUsage } from "./client.js";

export type SemanticTargetKind = "repo" | "package" | "directory" | "file" | "symbol" | "trace";
export type SemanticFlavor = "summary" | "summary-v2" | "pseudocode" | "narrative";

export interface CachedSemantic {
  content: string;
  model: string;
  sourceHash: string;
  createdAt: string;
}

export function getCachedSemantic(
  db: Db,
  targetKind: SemanticTargetKind,
  targetKey: string,
  flavor: SemanticFlavor,
  lang: string,
  sourceHash?: string,
  model?: string,
): CachedSemantic | null {
  const args: unknown[] = [targetKind, targetKey, flavor, lang];
  const hashClause = sourceHash === undefined ? "" : "AND source_hash = ?";
  if (sourceHash !== undefined) args.push(sourceHash);
  const modelClause = model === undefined ? "" : "AND model = ?";
  if (model !== undefined) args.push(model);
  const row = db
    .prepare(
      `SELECT content, model, source_hash AS sourceHash, created_at AS createdAt
       FROM summaries
       WHERE target_kind = ? AND target_key = ? AND flavor = ? AND lang = ? ${hashClause} ${modelClause}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...args) as CachedSemantic | undefined;
  return row ?? null;
}

export function putCachedSemantic(
  db: Db,
  input: {
    targetKind: SemanticTargetKind;
    targetKey: string;
    flavor: SemanticFlavor;
    lang: string;
    content: string;
    sourceHash: string;
    model: string;
  },
): void {
  db.prepare(
    `INSERT INTO summaries
       (target_kind, target_key, flavor, lang, content, source_hash, model, created_at)
     VALUES (@targetKind, @targetKey, @flavor, @lang, @content, @sourceHash, @model, @createdAt)
     ON CONFLICT(target_kind, target_key, flavor, lang) DO UPDATE SET
       content = excluded.content, source_hash = excluded.source_hash,
       model = excluded.model, created_at = excluded.created_at`,
  ).run({ ...input, createdAt: new Date().toISOString() });
}

export function invalidateCachedSemantic(
  db: Db,
  targetKind: SemanticTargetKind,
  targetKey: string,
  sourceHash: string,
): void {
  db.prepare(
    "DELETE FROM summaries WHERE target_kind = ? AND target_key = ? AND source_hash != ?",
  ).run(targetKind, targetKey, sourceHash);
}

export function semanticLanguage(db: Db): string {
  return getMeta(db, "llm_output_language") ?? "zh";
}

export interface StoredLlmStatus {
  enabled: boolean;
  available: boolean;
  model: string;
  interactiveModel?: string | null;
  reason?: string | null;
  usage: LlmUsage;
}

export function readLlmStatus(db: Db): StoredLlmStatus | null {
  return getMetaJson<StoredLlmStatus | null>(db, "llm_status", null);
}

export function writeLlmStatus(db: Db, value: StoredLlmStatus): void {
  setMetaJson(db, "llm_status", value);
}

export function mergeLlmStatusUsage(
  db: Db,
  input: Omit<StoredLlmStatus, "usage"> & { usage?: LlmUsage },
): void {
  const previous = readLlmStatus(db);
  // 模型切换后重新计数，避免把旧模型的 token 算到新模型头上。
  const usage = previous?.model === input.model ? previous.usage : emptyUsage();
  const add = input.usage ?? emptyUsage();
  writeLlmStatus(db, {
    enabled: input.enabled,
    available: input.available,
    model: input.model,
    interactiveModel: input.interactiveModel ?? previous?.interactiveModel ?? null,
    reason: input.reason ?? null,
    usage: {
      requests: usage.requests + add.requests,
      inputTokens: usage.inputTokens + add.inputTokens,
      outputTokens: usage.outputTokens + add.outputTokens,
      totalTokens: usage.totalTokens + add.totalTokens,
    },
  });
}
