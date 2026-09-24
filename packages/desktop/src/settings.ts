import { globalConfigPath, loadGlobalConfig } from "@repolens/core/config";
import { app, safeStorage } from "electron";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { LlmSettings, LlmSettingsInput } from "../../web/src/lib/desktop.js";

export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
}

/** 只属于桌面端的状态，放在 Electron 的 userData 目录里 */
interface DesktopState {
  /** safeStorage 加密后的 API key，base64 */
  llmApiKey?: string;
  /** 这个 key 属于哪个服务（服务地址的 origin）；配置里的服务地址换了就不再使用它 */
  llmApiKeyService?: string;
  /** 上次关闭窗口时在看的仓库 */
  lastRepo?: string;
  window?: WindowState;
}

function statePath(): string {
  return join(app.getPath("userData"), "state.json");
}

export function readState(): DesktopState {
  try {
    return JSON.parse(readFileSync(statePath(), "utf8")) as DesktopState;
  } catch {
    return {};
  }
}

export function writeState(patch: Partial<DesktopState>): void {
  const next = { ...readState(), ...patch };
  for (const key of Object.keys(next) as Array<keyof DesktopState>) {
    if (next[key] === undefined) delete next[key];
  }
  const path = statePath();
  mkdirSync(dirname(path), { recursive: true });
  // 先写临时文件再改名，写到一半断电也不会留下一个解析不了的文件
  writeFileSync(`${path}.tmp`, `${JSON.stringify(next, null, 2)}\n`);
  renameSync(`${path}.tmp`, path);
}

/**
 * Linux 上没有 Secret Service / KWallet 时 Electron 会退回 basic_text，
 * 用写死的密码“加密”，等于明文，不能当成已加密保存。
 */
function canEncrypt(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  return process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text";
}

/**
 * 在桌面端换了服务之后，key 改从这个变量读。原来的变量里放的是旧服务的 key，
 * 而配置文件和命令行共用，沿用旧变量名会让命令行把旧 key 发给新地址。
 */
const NEW_SERVICE_KEY_ENV = "REPOLENS_API_KEY";

/** 同一服务换个路径（/v1、/v2）还能共用 key；域名、协议或端口变了就是另一个服务 */
function serviceOf(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).origin;
  } catch {
    return null;
  }
}

function hasKeyFor(state: DesktopState, baseUrl: string): boolean {
  return state.llmApiKey !== undefined && state.llmApiKeyService !== undefined
    && state.llmApiKeyService === serviceOf(baseUrl);
}

/** 只有保存时对应的服务和现在配置的是同一个，才把 key 交出去 */
export function savedApiKey(baseUrl: string): string | null {
  const state = readState();
  if (!hasKeyFor(state, baseUrl) || !canEncrypt()) return null;
  try {
    return safeStorage.decryptString(Buffer.from(state.llmApiKey!, "base64"));
  } catch {
    // 换了机器或钥匙串被重置后解不开，当作没保存过
    return null;
  }
}

export function readLlmSettings(): LlmSettings {
  const llm = loadGlobalConfig().llm;
  const envName = llm.apiKeyEnv.trim();
  return {
    baseUrl: llm.baseUrl,
    model: llm.model,
    interactiveModel: llm.interactiveModel,
    apiKeyEnv: envName,
    newServiceKeyEnv: NEW_SERVICE_KEY_ENV,
    hasSavedKey: hasKeyFor(readState(), llm.baseUrl),
    envKeyPresent: envName !== "" && Boolean(process.env[envName]?.trim()),
    canSaveKey: canEncrypt(),
    configPath: globalConfigPath(),
  };
}

/** IPC 传进来的东西不能直接信任类型标注 */
export function parseLlmSettingsInput(value: unknown): LlmSettingsInput {
  const input = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;
  const text = (key: string) => (typeof input[key] === "string" ? input[key] as string : "");
  const apiKey = input["apiKey"];
  return {
    baseUrl: text("baseUrl"),
    model: text("model"),
    interactiveModel: typeof input["interactiveModel"] === "string" ? input["interactiveModel"] : null,
    requiresKey: input["requiresKey"] !== false,
    apiKey: typeof apiKey === "string" || apiKey === null ? apiKey : undefined,
  };
}

/**
 * 服务地址和模型写进与命令行共用的全局配置；key 只加密存在桌面端自己的状态里。
 *
 * 配置文件是用户可能手写过的 JSON，只改 llm 下的这几个字段，其余原样保留。
 * 文件本身解析不了时直接报错，不能拿一个空对象覆盖掉用户的内容。
 *
 * 换了服务时原来的 key（保存的和环境变量里的）一律不再使用，必须给新服务填新的，
 * 否则旧服务的 key 会被原样发到新地址。
 */
export function writeLlmSettings(input: LlmSettingsInput): void {
  const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
  const service = /^https?:\/\//i.test(baseUrl) ? serviceOf(baseUrl) : null;
  if (service === null) throw new Error("服务地址要以 http:// 或 https:// 开头");
  const model = input.model.trim();
  if (model === "") throw new Error("请填写模型名称");
  const apiKey = typeof input.apiKey === "string" ? input.apiKey.trim() : input.apiKey;
  const newKey = typeof apiKey === "string" && apiKey !== "" ? apiKey : null;
  if (newKey !== null && !canEncrypt()) throw new Error("系统钥匙串不可用，无法保存 Key");

  const path = globalConfigPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`配置文件 ${path} 不是合法的 JSON，先修正它再保存：${(err as Error).message}`);
    }
  }
  const previous = loadGlobalConfig().llm;
  const previousEnv = previous.apiKeyEnv.trim();
  const serviceChanged = serviceOf(previous.baseUrl) !== service;
  if (input.requiresKey && serviceChanged && newKey === null && canEncrypt()) {
    throw new Error("请填写新服务的 API Key");
  }

  const llm = typeof raw["llm"] === "object" && raw["llm"] !== null ? raw["llm"] as Record<string, unknown> : {};
  raw["llm"] = {
    ...llm,
    enabled: true,
    baseUrl,
    model,
    interactiveModel: input.interactiveModel?.trim() || null,
    apiKeyEnv: !input.requiresKey
      ? ""
      : serviceChanged || previousEnv === ""
        ? NEW_SERVICE_KEY_ENV
        : previousEnv,
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(raw, null, 2)}\n`);

  if (newKey !== null) {
    writeState({ llmApiKey: safeStorage.encryptString(newKey).toString("base64"), llmApiKeyService: service });
  } else if (apiKey === null || serviceChanged) {
    writeState({ llmApiKey: undefined, llmApiKeyService: undefined });
  }
}

/**
 * 服务进程应该看到的 key 环境变量。
 *
 * 保存过 key 就放进配置指定的变量名里，覆盖 shell 里继承来的；清除后退回
 * 继承来的值。变量名改了（比如切到无需密钥的服务），旧名字也要恢复原状。
 */
export function keyEnvUpdate(previousName: string | null): { name: string | null; values: Record<string, string | null> } {
  let name: string | null = null;
  let baseUrl = "";
  try {
    const llm = loadGlobalConfig().llm;
    name = llm.apiKeyEnv.trim() || null;
    baseUrl = llm.baseUrl;
  } catch {
    // 配置文件坏了：什么都不注入，AI 功能会各自报出配置错误
  }
  const values: Record<string, string | null> = {};
  if (previousName !== null && previousName !== name) values[previousName] = process.env[previousName] ?? null;
  if (name !== null) values[name] = savedApiKey(baseUrl) ?? process.env[name] ?? null;
  return { name, values };
}
