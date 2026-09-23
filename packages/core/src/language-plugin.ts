import { registerLanguage, type LanguageDefinition } from "./discovery/language.js";
import { registerExtractorFor } from "./parse/extractors/registry.js";
import type { LanguageExtractor } from "./parse/extractors/types.js";
import { registerResolverFor } from "./resolve/registry.js";
import type { ModuleResolver } from "./types.js";

export interface LanguagePlugin {
  definition: LanguageDefinition;
  /** 不提供时使用 definition.extractor 指定的内置抽取器（通常是 generic）。 */
  extractor?: LanguageExtractor;
  /** 可选的专用模块解析器；不提供就把 import 明确记为 unresolved。 */
  resolver?: ModuleResolver;
}

/**
 * 一次注册语言发现、grammar、结构抽取和模块解析能力。注册只影响后续扫描，
 * 进程启动后加载插件即可，不允许覆盖内置语言或另一插件的注册。
 */
export function registerLanguagePlugin(plugin: LanguagePlugin): void {
  const definition = plugin.extractor && !plugin.definition.extractor
    ? { ...plugin.definition, extractor: plugin.extractor.family }
    : plugin.definition;
  registerLanguage(definition);
  if (plugin.extractor) registerExtractorFor(definition.id, plugin.extractor);
  if (plugin.resolver) registerResolverFor(definition.id, plugin.resolver);
}
