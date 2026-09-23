import type { AnalyzableLanguage, Language, ModuleResolver } from "../types.js";
import { isAnalyzable, languageDefinitions, resolverFamily } from "../discovery/language.js";
import { createGoResolver } from "./go-resolver.js";
import { createPythonResolver } from "./python-resolver.js";
import { createRustResolver } from "./rust-resolver.js";
import { createTsResolver } from "./ts-resolver.js";

const CUSTOM_RESOLVERS = new Map<Language, ModuleResolver>();

/**
 * 解析器带内部缓存（tsconfig、模块树），所以每次扫描创建一组新实例，
 * 而不是共享全局单例——否则跨仓库扫描会读到上一个仓库的配置。
 */
export function createResolvers(): Map<AnalyzableLanguage, ModuleResolver> {
  const map = new Map<AnalyzableLanguage, ModuleResolver>();
  const families = {
    ts: createTsResolver(),
    python: createPythonResolver(),
    go: createGoResolver(),
    rust: createRustResolver(),
  } as const;
  for (const definition of languageDefinitions()) {
    if (!isAnalyzable(definition.id)) continue;
    const family = resolverFamily(definition.id);
    if (family) map.set(definition.id, families[family]);
  }
  for (const [language, resolver] of CUSTOM_RESOLVERS) {
    if (isAnalyzable(language)) map.set(language, resolver);
  }
  return map;
}

/** 供语言插件注册专用模块解析器；必须在扫描开始前调用。 */
export function registerResolverFor(language: Language, resolver: ModuleResolver): void {
  if (CUSTOM_RESOLVERS.has(language)) throw new Error(`语言 ${language} 已注册专用模块解析器`);
  CUSTOM_RESOLVERS.set(language, resolver);
}
