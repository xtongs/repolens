import { desktop } from "./desktop";

/**
 * 用户偏好的读写都走这里。浏览器里就是 localStorage。桌面端的本地服务每次启动
 * 端口都不同，页面换了来源，localStorage 也跟着换成一份空的，所以每次写入同时
 * 交给主进程存进状态文件，页面脚本运行前再由 preload 灌回 localStorage。
 */
export function readPref(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** null 表示清掉，回到默认 */
export function writePref(key: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch {
    // 浏览器禁用存储时，本次调整仍然有效
  }
  desktop?.savePref(key, value);
}
