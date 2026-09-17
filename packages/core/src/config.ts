import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { FileRole, RepolensConfig } from "./types.js";

export const CONFIG_FILENAME = ".repolens.json";

export const DEFAULT_ROLES: FileRole[] = ["source"];

export const DEFAULT_CONFIG: RepolensConfig = {
  exclude: [],
  include: [],
  maxFileBytes: 1_500_000,
  maxNodesPerView: 30,
  defaultRoles: DEFAULT_ROLES,
  llm: {
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    interactiveModel: null,
    apiKeyEnv: "OPENAI_API_KEY",
    maxConcurrency: 4,
    temperature: 0.1,
    reasoningEffort: null,
    maxOutputTokens: 1200,
    requestTimeoutMs: 30_000,
    maxRetries: 2,
    scanBatchSize: 8,
    scanMaxCalls: 99,
    outputLanguage: "zh",
    enabled: true,
  },
};

/**
 * 读取 `<repo>/.repolens.json`。配置缺失是常态而不是错误——
 * RepoLens 的核心功能不依赖任何配置。
 */
export function loadConfig(repoRoot: string): RepolensConfig {
  const path = join(repoRoot, CONFIG_FILENAME);
  if (!existsSync(path)) return structuredClone(DEFAULT_CONFIG);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_FILENAME} 解析失败：${(err as Error).message}`);
  }
  return mergeConfig(DEFAULT_CONFIG, raw);
}

function mergeConfig(base: RepolensConfig, patch: unknown): RepolensConfig {
  if (typeof patch !== "object" || patch === null) return structuredClone(base);
  const p = patch as Partial<RepolensConfig> & { llm?: Partial<RepolensConfig["llm"]> };
  return {
    exclude: p.exclude ?? base.exclude,
    include: p.include ?? base.include,
    maxFileBytes: p.maxFileBytes ?? base.maxFileBytes,
    maxNodesPerView: p.maxNodesPerView ?? base.maxNodesPerView,
    defaultRoles: p.defaultRoles ?? base.defaultRoles,
    llm: normalizeLlmConfig({ ...base.llm, ...(p.llm ?? {}) }),
  };
}

function normalizeLlmConfig(config: RepolensConfig["llm"]): RepolensConfig["llm"] {
  return {
    ...config,
    baseUrl: config.baseUrl.replace(/\/+$/, ""),
    interactiveModel:
      typeof config.interactiveModel === "string" && config.interactiveModel.trim() !== ""
        ? config.interactiveModel.trim()
        : null,
    maxConcurrency: clampInt(config.maxConcurrency, 1, 16, 4),
    temperature: Number.isFinite(config.temperature)
      ? Math.min(2, Math.max(0, config.temperature))
      : 0.1,
    reasoningEffort:
      config.reasoningEffort === "low" ||
      config.reasoningEffort === "medium" ||
      config.reasoningEffort === "high" ||
      config.reasoningEffort === null
        ? config.reasoningEffort
        : "low",
    maxOutputTokens: clampInt(config.maxOutputTokens, 64, 16_384, 1200),
    requestTimeoutMs: clampInt(config.requestTimeoutMs, 1_000, 300_000, 30_000),
    maxRetries: clampInt(config.maxRetries, 0, 8, 2),
    scanBatchSize: clampInt(config.scanBatchSize, 1, 20, 8),
    scanMaxCalls: clampInt(config.scanMaxCalls, 1, 99, 99),
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
