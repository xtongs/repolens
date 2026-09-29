import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DesktopBridge, DesktopCommand } from "../../web/src/lib/desktop.js";
import { IPC } from "./ipc.js";

/** ipcRenderer.invoke 的报错会带上「Error invoking remote method …」前缀，界面上只留原话 */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  try {
    return (await ipcRenderer.invoke(channel, ...args)) as T;
  } catch (err) {
    throw new Error(String((err as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
  }
}

function subscribe<T>(channel: string, listener: (value: T) => void): () => void {
  const handler = (_event: IpcRendererEvent, value: T) => listener(value);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.off(channel, handler);
}

/**
 * 本地服务每次启动端口都不同，页面换了来源，localStorage 就是一份空的。页面脚本
 * 运行前把主进程存下的偏好灌回去，页面照常只读 localStorage。偏好里已经没有的旧键
 * 也清掉：端口碰巧和很久以前某次一样时，那份 localStorage 里还留着过期的值。
 */
function restorePrefs(): void {
  try {
    const prefs = ipcRenderer.sendSync(IPC.loadPrefs) as Record<string, string>;
    // 这个包的类型不带 DOM，只声明用到的两个方法
    const storage = (globalThis as unknown as {
      localStorage: { setItem(key: string, value: string): void; removeItem(key: string): void };
    }).localStorage;
    for (const key of Object.keys(storage)) {
      if (key.startsWith("repolens") && !(key in prefs)) storage.removeItem(key);
    }
    for (const [key, value] of Object.entries(prefs)) storage.setItem(key, value);
  } catch {
    // 读不到就用默认设置
  }
}

restorePrefs();

const bridge: DesktopBridge = {
  platform: process.platform as DesktopBridge["platform"],
  getLlmSettings: () => invoke(IPC.getLlmSettings),
  saveLlmSettings: (input) => invoke(IPC.saveLlmSettings, input),
  onCommand: (listener) => subscribe<DesktopCommand>(IPC.command, listener),
  onFullScreenChange: (listener) => subscribe<boolean>(IPC.fullScreen, listener),
  setLocale: (locale) => ipcRenderer.send(IPC.setLocale, locale),
  savePref: (key, value) => ipcRenderer.send(IPC.savePref, key, value),
};

contextBridge.exposeInMainWorld("repolensDesktop", bridge);
