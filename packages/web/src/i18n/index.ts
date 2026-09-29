import { create } from "zustand";
import { readPref, writePref } from "../lib/prefs";
import { EN, EN_PATTERNS } from "./en";

export type Locale = "zh" | "en";

export type MessageParams = Record<string, string | number>;
/** 英文词条可以是函数，用来处理单复数这类中文不需要区分的情况 */
export type Translation = string | ((params: MessageParams) => string);

const STORAGE_KEY = "repolens-locale";

interface LocaleState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

/**
 * 界面语言。中文原文直接当键：代码里读到的就是界面上显示的字，
 * 英文词典按原文查，查不到时原样显示中文，漏翻一条不至于变成空白。
 */
export const useLocaleStore = create<LocaleState>((set) => ({
  locale: initialLocale(),
  setLocale(locale) {
    writePref(STORAGE_KEY, locale);
    applyDocumentLocale(locale);
    set({ locale });
  },
}));

applyDocumentLocale(useLocaleStore.getState().locale);

export function t(message: string, params?: MessageParams): string {
  const translation = useLocaleStore.getState().locale === "en" ? lookup(message) : undefined;
  if (typeof translation === "function") return translation(params ?? {});
  return interpolate(translation ?? message, params);
}

/** 只认词典自己的键：服务端报错原文可能恰好是 constructor 这类原型上的名字 */
function lookup(message: string): Translation | undefined {
  return Object.hasOwn(EN, message) ? EN[message] : undefined;
}

/**
 * 服务端和桌面主进程传来的报错、状态说明。它们不经过 t()，其中一部分还
 * 嵌着路径或名字，整句查不到时再按 EN_PATTERNS 匹配；都不认识就原样显示。
 */
export function translateMessage(message: string): string {
  if (useLocaleStore.getState().locale !== "en") return message;
  if (lookup(message) !== undefined) return t(message);
  for (const [pattern, render] of EN_PATTERNS) {
    const match = pattern.exec(message);
    if (match) return render(...match.slice(1));
  }
  return message;
}

/**
 * 组件里调用它，换语言时组件跟着重新渲染。返回的就是 t 本身，
 * 同一文件里已经导入了 t 的，只调用不接返回值也一样。
 */
export function useT(): typeof t {
  useLocaleStore((s) => s.locale);
  return t;
}

export function useLocale(): Locale {
  return useLocaleStore((s) => s.locale);
}

/** 日期时间按界面语言格式化，而不是按浏览器的系统语言 */
export function intlLocale(): string {
  return useLocaleStore.getState().locale === "en" ? "en-US" : "zh-CN";
}

/**
 * 标记一段稍后才翻译的文案，原样返回。模块顶层的标签表用它：
 * 取值要等到渲染时再过 t()，否则切换语言后还停在加载时的那一种。
 */
export function msg(message: string): string {
  return message;
}

function interpolate(template: string, params: MessageParams | undefined): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in params ? String(params[key]) : match));
}

function initialLocale(): Locale {
  const stored = readPref(STORAGE_KEY);
  if (stored === "zh" || stored === "en") return stored;
  const language = typeof navigator === "undefined" ? "zh" : navigator.language.toLowerCase();
  return language.startsWith("zh") ? "zh" : "en";
}

function applyDocumentLocale(locale: Locale): void {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
}
