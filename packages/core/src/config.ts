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
    apiKeyEnv: "OPENAI_API_KEY",
    maxConcurrency: 4,
    temperature: 0.1,
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
    llm: { ...base.llm, ...(p.llm ?? {}) },
  };
}
