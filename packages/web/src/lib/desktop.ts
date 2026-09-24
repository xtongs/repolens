/**
 * 桌面客户端通过 preload 注入的能力。
 *
 * 在浏览器里打开（命令行 `repolens open`）时为 null，依赖它的入口——AI 设置、
 * 原生菜单命令——都不出现。preload 里的实现以这里的类型为准。
 */
export type DesktopPlatform = "darwin" | "win32" | "linux";

export type DesktopCommand = "add-repository" | "open-settings";

export interface LlmSettings {
  baseUrl: string;
  model: string;
  interactiveModel: string | null;
  /** 为空表示接口不需要密钥，例如本机的 Ollama */
  apiKeyEnv: string;
  /** 换了服务地址后 key 改从这个环境变量读，旧变量里是旧服务的 key */
  newServiceKeyEnv: string;
  /** 客户端里为当前服务地址保存过 key，由系统钥匙串加密 */
  hasSavedKey: boolean;
  /** 没有保存 key 时，环境变量里是否已经有一个（例如从 shell 配置继承） */
  envKeyPresent: boolean;
  /** 系统能否加密保存 key；Linux 上没有钥匙串服务时为 false */
  canSaveKey: boolean;
  /** 服务地址和模型写在这个文件里，与命令行共用 */
  configPath: string;
}

export interface LlmSettingsInput {
  baseUrl: string;
  model: string;
  interactiveModel: string | null;
  requiresKey: boolean;
  /** 不传表示保留原来的 key，null 表示清除 */
  apiKey?: string | null;
}

export interface DesktopBridge {
  platform: DesktopPlatform;
  getLlmSettings: () => Promise<LlmSettings>;
  saveLlmSettings: (input: LlmSettingsInput) => Promise<LlmSettings>;
  /** 原生菜单触发的命令；返回取消订阅函数 */
  onCommand: (listener: (command: DesktopCommand) => void) => () => void;
  /** macOS 全屏时红绿灯按钮会隐藏，顶栏不必再给它们留位置 */
  onFullScreenChange: (listener: (fullScreen: boolean) => void) => () => void;
}

export const desktop: DesktopBridge | null =
  (globalThis as { repolensDesktop?: DesktopBridge }).repolensDesktop ?? null;
