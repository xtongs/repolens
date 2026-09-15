import type { AnalyzableLanguage, Language } from "../types.js";

const BY_EXTENSION: Record<string, Language> = {
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".js": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".jsx": "jsx",
  ".py": "python",
  ".pyi": "python",
  ".go": "go",
  ".rs": "rust",
  ".json": "json",
  ".jsonc": "json",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".md": "markdown",
  ".mdx": "markdown",
  ".sh": "shell",
  ".bash": "shell",
  ".zsh": "shell",
};

const ANALYZABLE = new Set<Language>([
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "python",
  "go",
  "rust",
]);

export function detectLanguage(path: string): Language {
  const dot = path.lastIndexOf(".");
  if (dot <= 0) return "other";
  const ext = path.slice(dot).toLowerCase();
  return BY_EXTENSION[ext] ?? "other";
}

export function isAnalyzable(language: Language): language is AnalyzableLanguage {
  return ANALYZABLE.has(language);
}

/** tree-sitter 语法文件名，多个 Language 可能共用一个语法 */
export function grammarFor(language: AnalyzableLanguage): string {
  switch (language) {
    case "typescript":
      return "typescript";
    case "tsx":
    case "jsx":
      return "tsx";
    case "javascript":
      return "javascript";
    case "python":
      return "python";
    case "go":
      return "go";
    case "rust":
      return "rust";
  }
}

/** 抽取器分组：jsx/tsx 与 ts/js 共用同一套抽取逻辑 */
export function extractorFamily(language: AnalyzableLanguage): "ts" | "python" | "go" | "rust" {
  switch (language) {
    case "typescript":
    case "tsx":
    case "javascript":
    case "jsx":
      return "ts";
    case "python":
      return "python";
    case "go":
      return "go";
    case "rust":
      return "rust";
  }
}
