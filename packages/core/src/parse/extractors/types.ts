import type { Node as TsNode } from "web-tree-sitter";
import type { AnalyzableLanguage, ParsedFile } from "../../types.js";

export type { TsNode };

export interface ExtractInput {
  root: TsNode;
  /** 源码文本，用于取签名原文与文档注释 */
  source: string;
  language: AnalyzableLanguage;
  /** 仓库相对路径，Go/Rust 的模块归属判定需要它 */
  path: string;
}

export interface LanguageExtractor {
  family: "ts" | "python" | "go" | "rust";
  extract: (input: ExtractInput) => ParsedFile;
}

export function emptyParsedFile(hasError = false): ParsedFile {
  return {
    symbols: [],
    imports: [],
    exports: [],
    calls: [],
    entryHints: [],
    typeRelations: [],
    hasError,
  };
}
