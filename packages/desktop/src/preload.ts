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

const bridge: DesktopBridge = {
  platform: process.platform as DesktopBridge["platform"],
  getLlmSettings: () => invoke(IPC.getLlmSettings),
  saveLlmSettings: (input) => invoke(IPC.saveLlmSettings, input),
  onCommand: (listener) => subscribe<DesktopCommand>(IPC.command, listener),
  onFullScreenChange: (listener) => subscribe<boolean>(IPC.fullScreen, listener),
};

contextBridge.exposeInMainWorld("repolensDesktop", bridge);
