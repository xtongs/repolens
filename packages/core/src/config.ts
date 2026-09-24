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
  roleOverrides: {},
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
  let config = loadGlobalConfig();
  const repoPath = join(repoRoot, CONFIG_FILENAME);
  if (existsSync(repoPath)) config = mergeConfig(config, withoutCredentialRouting(readConfig(repoPath)));
  return config;
}

/**
 * 仓库级配置随代码一起被克隆下来，不可信。允许它改服务地址或 key 的变量名，
 * 打开一个陌生仓库就可能把本机任意环境变量当成 key 发到任意地址，所以这两项只认用户级配置。
 */
function withoutCredentialRouting(patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null) return patch;
  const llm = (patch as { llm?: unknown }).llm;
  if (typeof llm !== "object" || llm === null) return patch;
  const { baseUrl: _baseUrl, apiKeyEnv: _apiKeyEnv, ...rest } = llm as Record<string, unknown>;
  return { ...patch, llm: rest };
}

/** 内置默认值叠加用户级共享配置，不含任何仓库的覆盖。桌面端的 AI 设置读写的就是这一层。 */
export function loadGlobalConfig(): RepolensConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const globalPath = globalConfigPath();
  return existsSync(globalPath) ? mergeConfig(config, readConfig(globalPath)) : config;
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
    roleOverrides: normalizeRoleOverrides(p.roleOverrides, base.roleOverrides),
    maxFileBytes: p.maxFileBytes ?? base.maxFileBytes,
    maxNodesPerView: p.maxNodesPerView ?? base.maxNodesPerView,
    defaultRoles: p.defaultRoles ?? base.defaultRoles,
    llm: normalizeLlmConfig({ ...base.llm, ...(p.llm ?? {}) }),
  };
}

const FILE_ROLES = new Set<FileRole>([
  "source", "test", "config", "generated", "types", "docs", "asset", "vendor",
]);

function normalizeRoleOverrides(
  value: unknown,
  fallback: Record<string, FileRole>,
): Record<string, FileRole> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return structuredClone(fallback);
  }
  const out: Record<string, FileRole> = {};
  for (const [pattern, role] of Object.entries(value)) {
    if (pattern.trim() !== "" && typeof role === "string" && FILE_ROLES.has(role as FileRole)) {
      out[pattern] = role as FileRole;
    }
  }
  return { ...fallback, ...out };
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
