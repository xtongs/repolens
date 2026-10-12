import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeJsonAtomically } from "./json-file.js";
import type {
  ArchitectureLock,
  ArchitectureRule,
  ConfirmedLayer,
  FileRole,
  LockedDependency,
  RatchetConfig,
  RatchetKind,
  RepolensConfig,
  TourDto,
  TourStepDto,
} from "./types.js";

/** 团队约定：依赖规则、确认过的分层、导览。随代码提交，所有人和 CI 读到的是同一份 */
export const CONFIG_FILENAME = ".repolens.json";
/** 个人在这个仓库上的覆盖，不提交 */
export const LOCAL_CONFIG_FILENAME = ".repolens.local.json";
/** 依赖锁：团队批准过的模块间依赖，由 `repolens lock` 生成，随代码提交 */
export const LOCK_FILENAME = ".repolens.lock.json";
export const GLOBAL_CONFIG_DIR = "repolens";
export const GLOBAL_CONFIG_FILENAME = "config.json";

export const DEFAULT_ROLES: FileRole[] = ["source"];

const RATCHET_KINDS: readonly RatchetKind[] = ["cycle", "violation", "unapproved", "layering", "bypass", "duplicate", "oversized"];

export const DEFAULT_CONFIG: RepolensConfig = {
  exclude: [],
  include: [],
  roleOverrides: {},
  maxFileBytes: 1_500_000,
  maxNodesPerView: 30,
  defaultRoles: DEFAULT_ROLES,
  rules: [],
  layers: [],
  tours: [],
  // 违反团队写下的约定一律拦下；重复和巨石先提示，等团队决定要不要收紧
  ratchet: { fail: ["cycle", "violation", "unapproved", "layering", "bypass"], warn: ["duplicate", "oversized"] },
  history: true,
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
    chatTools: true,
    webFetch: true,
  },
};

/** 用户级共享配置路径。遵循 XDG；macOS 未设置时落到 ~/.config。 */
export function globalConfigPath(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]?.trim();
  const configHome = xdg && xdg.length > 0 ? xdg : join(homedir(), ".config");
  return join(configHome, GLOBAL_CONFIG_DIR, GLOBAL_CONFIG_FILENAME);
}

/**
 * 四级配置继承：内置默认值 → 用户级共享配置 → 仓库的团队约定 → 个人在这个仓库上的覆盖。
 *
 * 文件都可以缺失。团队约定（.repolens.json）随代码提交：依赖规则、确认过的分层、
 * 导览、exclude 和文件角色，CI 里的 `repolens check` 读的也是它。个人覆盖
 * （.repolens.local.json）不提交，适合只在自己机器上关掉某个仓库的 LLM。
 * 凭据始终只由 apiKeyEnv 指向环境变量，不在这里读取明文 key。
 */
export function loadConfig(repoRoot: string): RepolensConfig {
  let config = loadGlobalConfig();
  for (const name of [CONFIG_FILENAME, LOCAL_CONFIG_FILENAME]) {
    const path = join(repoRoot, name);
    if (existsSync(path)) config = mergeConfig(config, withoutCredentialRouting(readConfig(path)));
  }
  return config;
}

/**
 * 改团队约定文件里的几个键，其余原样保留。界面上「确认分层」「保存导览」走这里：
 * 这些是团队的决定，落在随代码提交的文件里，评审时看得见。
 */
export function updateTeamConfig(repoRoot: string, patch: Partial<Pick<RepolensConfig, "layers" | "tours">>): void {
  const path = join(repoRoot, CONFIG_FILENAME);
  let current: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error(`RepoLens 配置不是 JSON 对象：${path}`);
    }
    current = parsed as Record<string, unknown>;
  }
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) delete next[key];
    else next[key] = value;
  }
  writeJsonAtomically(path, next);
}

/** 依赖锁不存在时为 null；文件写坏了直接报错，不能当成「没有锁」放过所有新依赖 */
export function loadLock(repoRoot: string): ArchitectureLock | null {
  const path = join(repoRoot, LOCK_FILENAME);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`依赖锁解析失败：${path}：${(err as Error).message}`);
  }
  const raw = (typeof parsed === "object" && parsed !== null ? parsed : {}) as Record<string, unknown>;
  const level = raw["level"] === "directory" ? "directory" : raw["level"] === "package" ? "package" : null;
  if (level === null || !Array.isArray(raw["dependencies"])) throw new Error(`依赖锁格式不对：${path}`);
  const dependencies = (raw["dependencies"] as unknown[]).flatMap((item): LockedDependency[] => {
    const dep = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const from = nonEmpty(dep["from"]);
    const to = nonEmpty(dep["to"]);
    if (from === null || to === null) return [];
    return [{ from, to, type: dep["type"] === "http" ? "http" : "imports" }];
  });
  return { version: 1, level, modules: globList(raw["modules"]), dependencies };
}

export function writeLock(repoRoot: string, lock: ArchitectureLock): void {
  const sorted: ArchitectureLock = {
    ...lock,
    modules: [...lock.modules].sort(),
    dependencies: [...lock.dependencies].sort((a, b) =>
      a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type)),
  };
  writeJsonAtomically(join(repoRoot, LOCK_FILENAME), sorted);
}

/**
 * 仓库级配置随代码一起被克隆下来，不可信。允许它改服务地址或 key 的变量名，
 * 打开一个陌生仓库就可能把本机任意环境变量当成 key 发到任意地址，所以这两项只认用户级配置。
 * 追问工具同理：仓库只能把它们关掉，不能替用户打开。
 */
function withoutCredentialRouting(patch: unknown): unknown {
  if (typeof patch !== "object" || patch === null) return patch;
  const llm = (patch as { llm?: unknown }).llm;
  if (typeof llm !== "object" || llm === null) return patch;
  const { baseUrl: _baseUrl, apiKeyEnv: _apiKeyEnv, chatTools, webFetch, ...rest } = llm as Record<string, unknown>;
  return {
    ...patch,
    llm: { ...rest, ...(chatTools === false ? { chatTools } : {}), ...(webFetch === false ? { webFetch } : {}) },
  };
}

/** 内置默认值叠加用户级共享配置，不含任何仓库的覆盖。桌面端的 AI 设置读写的就是这一层。 */
export function loadGlobalConfig(): RepolensConfig {
  const config = structuredClone(DEFAULT_CONFIG);
  const globalPath = globalConfigPath();
  return existsSync(globalPath) ? mergeConfig(config, readConfig(globalPath)) : config;
}

function readConfig(path: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (err) {
    throw new Error(`RepoLens 配置解析失败：${path}：${(err as Error).message}`);
  }
  if (typeof parsed === "object" && parsed !== null) {
    const record = parsed as Record<string, unknown>;
    if ("rules" in record) record["rules"] = normalizeRules(record["rules"], path);
    if ("layers" in record) record["layers"] = normalizeLayers(record["layers"], path);
    if ("tours" in record) record["tours"] = normalizeTours(record["tours"]);
    if ("ratchet" in record) record["ratchet"] = normalizeRatchet(record["ratchet"]);
  }
  return parsed;
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
    rules: p.rules ?? base.rules,
    layers: p.layers ?? base.layers,
    tours: p.tours ?? base.tours,
    ratchet: p.ratchet ?? base.ratchet,
    history: typeof p.history === "boolean" ? p.history : base.history,
    llm: normalizeLlmConfig({ ...base.llm, ...(p.llm ?? {}) }),
  };
}

/** 分层写错同样直接报错：漏掉一层，倒置检查就静默地少查一块 */
function normalizeLayers(value: unknown, path: string): ConfirmedLayer[] {
  if (!Array.isArray(value)) throw new Error(`RepoLens 配置里的 layers 必须是数组：${path}`);
  return value.map((raw, index) => {
    const layer = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const name = nonEmpty(layer["name"]);
    const members = globList(layer["members"]).filter((id) => /^(?:pkg|dir):./.test(id));
    if (name === null || members.length === 0) {
      throw new Error(`RepoLens 配置里第 ${index + 1} 个分层缺少 name 或 members（成员写成 pkg:包名 或 dir:目录）：${path}`);
    }
    return { name, description: nonEmpty(layer["description"]), members };
  });
}

/** 导览是人写的说明，个别步骤写坏了跳过那一步，不连累整份配置 */
function normalizeTours(value: unknown): TourDto[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw, index): TourDto[] => {
    const tour = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const title = nonEmpty(tour["title"]);
    if (title === null || !Array.isArray(tour["steps"])) return [];
    const steps = (tour["steps"] as unknown[]).flatMap((item): TourStepDto[] => {
      const step = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
      const target = nonEmpty(step["target"]);
      if (target === null || !/^(?:repo$|pkg:|dir:|path:|symbol:)/.test(target)) return [];
      return [{ target, title: nonEmpty(step["title"]) ?? target, note: nonEmpty(step["note"]) }];
    });
    return [{ id: nonEmpty(tour["id"]) ?? `tour-${index + 1}`, title, description: nonEmpty(tour["description"]), steps }];
  });
}

function normalizeRatchet(value: unknown): RatchetConfig {
  const raw = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const kinds = (list: unknown, fallback: RatchetKind[]) =>
    Array.isArray(list) ? list.filter((kind): kind is RatchetKind => RATCHET_KINDS.includes(kind as RatchetKind)) : fallback;
  const fail = kinds(raw["fail"], DEFAULT_CONFIG.ratchet.fail);
  return { fail, warn: kinds(raw["warn"], DEFAULT_CONFIG.ratchet.warn).filter((kind) => !fail.includes(kind)) };
}

/**
 * 写错的规则直接报错而不是跳过：静默丢掉一条禁令，体检就会一直显示「没有违规」，
 * 人会以为架构守住了。
 */
function normalizeRules(value: unknown, path: string): ArchitectureRule[] {
  if (!Array.isArray(value)) throw new Error(`RepoLens 配置里的 rules 必须是数组：${path}`);
  return value.map((raw, index) => {
    const rule = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const from = globList(rule["from"]);
    const disallow = globList(rule["disallow"]);
    if (from.length === 0 || disallow.length === 0) {
      throw new Error(`RepoLens 配置里第 ${index + 1} 条规则缺少 from 或 disallow：${path}`);
    }
    const severity = rule["severity"];
    return {
      name: nonEmpty(rule["name"]),
      from,
      disallow,
      allow: globList(rule["allow"]),
      includeTypeOnly: rule["includeTypeOnly"] === true,
      severity: severity === "medium" || severity === "low" ? severity : "high",
      reason: nonEmpty(rule["reason"]),
    };
  });
}

function globList(value: unknown): string[] {
  const list = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return list
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().replace(/^\.\//, ""))
    .filter((item) => item !== "");
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
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
    chatTools: config.chatTools !== false,
    webFetch: config.webFetch !== false,
  };
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
