import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { FileRole, RepolensConfig } from "./types.js";

export const CONFIG_FILENAME = ".repolens.json";
export const GLOBAL_CONFIG_DIR = "repolens";
export const GLOBAL_CONFIG_FILENAME = "config.json";

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

/** 用户级共享配置路径。遵循 XDG；macOS 未设置时落到 ~/.config。 */
export function globalConfigPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  const configHome = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(configHome, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILENAME);
}

/**
 * 三级配置继承：内置默认值 → 用户级共享配置 → 仓库级覆盖。
 *
 * 两个文件都可以缺失；仓库级尤其适合 exclude/include，以及显式关闭某个
 * 仓库的 LLM。凭据始终只由 apiKeyEnv 指向环境变量，不在这里读取明文 key。
 */
export function loadConfig(repoRoot: string): RepolensConfig {
  let config = structuredClone(DEFAULT_CONFIG);
  const globalPath = globalConfigPath();
  if (existsSync(globalPath)) config = mergeConfig(config, readConfig(globalPath));

  const repoPath = join(repoRoot, CONFIG_FILENAME);
  if (existsSync(repoPath)) config = mergeConfig(config, readConfig(repoPath));
  return config;
}

function readConfig(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`RepoLens 配置解析失败：${path}：${(err as Error).message}`);
  }
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
