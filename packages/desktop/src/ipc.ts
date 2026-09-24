/** 渲染进程与主进程之间的 IPC 频道 */
export const IPC = {
  getLlmSettings: "repolens:get-llm-settings",
  saveLlmSettings: "repolens:save-llm-settings",
  command: "repolens:command",
  fullScreen: "repolens:full-screen",
} as const;

/** 主进程发给服务进程 */
export type ToServer =
  | { type: "start"; accessToken: string; webRoot: string }
  | { type: "picked"; id: number; path: string | null }
  /** 更新环境变量，null 表示删除。新设置的 API key 靠它生效，不必重启服务 */
  | { type: "env"; id: number; values: Record<string, string | null> };

/** 服务进程发给主进程 */
export type FromServer =
  | { type: "ready"; port: number }
  | { type: "failed"; error: string }
  /** 环境变量已生效。消息和 HTTP 请求走不同通道，渲染进程要等到这一步再去重取状态 */
  | { type: "env-applied"; id: number }
  /** 服务进程里没有 Electron 的对话框 API，目录选择要请主进程代劳 */
  | { type: "pick-directory"; id: number };
