import type { AnalyzableLanguage } from "../../types.js";
import { extractorFamily } from "../../discovery/language.js";
import { goExtractor } from "./go.js";
import { pythonExtractor } from "./python.js";
import { rustExtractor } from "./rust.js";
import { typescriptExtractor } from "./typescript.js";
import type { LanguageExtractor } from "./types.js";

const BY_FAMILY: Record<"ts" | "python" | "go" | "rust", LanguageExtractor> = {
  ts: typescriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  rust: rustExtractor,
};

export function extractorFor(language: AnalyzableLanguage): LanguageExtractor {
  return BY_FAMILY[extractorFamily(language)];
}
