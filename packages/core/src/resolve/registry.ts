import type { AnalyzableLanguage, ModuleResolver } from "../types.js";
import { createGoResolver } from "./go-resolver.js";
import { createPythonResolver } from "./python-resolver.js";
import { createRustResolver } from "./rust-resolver.js";
import { createTsResolver } from "./ts-resolver.js";

/**
 * 解析器带内部缓存（tsconfig、模块树），所以每次扫描创建一组新实例，
 * 而不是共享全局单例——否则跨仓库扫描会读到上一个仓库的配置。
 */
export function createResolvers(): Map<AnalyzableLanguage, ModuleResolver> {
  const map = new Map<AnalyzableLanguage, ModuleResolver>();
  for (const resolver of [
    createTsResolver(),
    createPythonResolver(),
    createGoResolver(),
    createRustResolver(),
  ]) {
    for (const lang of resolver.languages) map.set(lang, resolver);
  }
  return map;
}
