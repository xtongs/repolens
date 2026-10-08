import type { LlmConfig, LlmUsage } from "../types.js";
import { loadConfig } from "../config.js";
import type { Db } from "../db/database.js";
import { readLlmStatus, writeLlmStatus, type StoredLlmStatus } from "../db/semantic.js";
import { emptyUsage, llmUnavailableReason } from "./client.js";

/**
 * 概览展示的 AI 状态：开关、模型、凭据按当前配置判断，累计用量取索引里记下的。
 *
 * 索引里存的状态停在上次扫描那一刻。扫描之后才设置 key、换了模型，或在
 * 桌面端填了 key，都应该立刻反映到界面上，而不是等下一次重扫。
 */
export function currentLlmStatus(db: Db, repoRoot: string): StoredLlmStatus | null {
  const stored = readLlmStatus(db);
  let config: LlmConfig;
  try {
    config = loadConfig(repoRoot).llm;
  } catch (err) {
    // 配置文件写坏了不该拖垮整张概览；真正调用 AI 时会报出同一个错误
    return stored && { ...stored, available: false, reason: (err as Error).message };
  }
  const reason = llmUnavailableReason(config);
  return {
    enabled: config.enabled,
    available: reason === null,
    model: config.model,
    interactiveModel: config.interactiveModel,
    reason,
    usage: stored?.model === config.model ? stored.usage : emptyUsage(),
  };
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
