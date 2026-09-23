import type { AnalyzableLanguage, Language } from "../../types.js";
import { extractorFamily } from "../../discovery/language.js";
import { goExtractor } from "./go.js";
import { genericExtractor } from "./generic.js";
import { pythonExtractor } from "./python.js";
import { rustExtractor } from "./rust.js";
import { typescriptExtractor } from "./typescript.js";
import type { LanguageExtractor } from "./types.js";

const BY_FAMILY: Record<"ts" | "python" | "go" | "rust" | "generic", LanguageExtractor> = {
  ts: typescriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  rust: rustExtractor,
  generic: genericExtractor,
};
const BY_LANGUAGE = new Map<Language, LanguageExtractor>();

export function extractorFor(language: AnalyzableLanguage): LanguageExtractor {
  return BY_LANGUAGE.get(language) ?? BY_FAMILY[extractorFamily(language)];
}

/** 供语言插件覆盖通用抽取器；必须在扫描开始前注册。 */
export function registerExtractorFor(language: Language, extractor: LanguageExtractor): void {
  if (BY_LANGUAGE.has(language)) throw new Error(`语言 ${language} 已注册专用抽取器`);
  BY_LANGUAGE.set(language, extractor);
}
