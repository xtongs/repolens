import { app } from "electron";

export type Locale = "zh" | "en";

let current: Locale | null = null;

/**
 * 原生菜单和对话框的语言，跟着界面走：页面每次加载都会报一次当前语言。
 * 在那之前（启动时建菜单、服务起不来的报错）用上次记下的，没有就按系统语言，
 * 与页面自己的默认值一致。
 */
export function locale(): Locale {
  return current ?? (app.getLocale().toLowerCase().startsWith("zh") ? "zh" : "en");
}

export function setLocale(next: Locale): void {
  current = next;
}

export function isLocale(value: unknown): value is Locale {
  return value === "zh" || value === "en";
}

/** 主进程的文案不多，两种语言直接写在用到的地方 */
export function tr(zh: string, en: string): string {
  return locale() === "en" ? en : zh;
}
