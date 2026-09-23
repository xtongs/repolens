import type { AnalyzableLanguage, BuiltinLanguage, Language } from "../types.js";

export type ExtractorFamily = "ts" | "python" | "go" | "rust" | "generic";
export type ResolverFamily = "ts" | "python" | "go" | "rust";
export type EmbeddedSourceKind = "vue" | "svelte" | "astro";

/** 一种语言的完整能力声明；发现、解析和模块解析都以此为唯一事实来源。 */
export interface LanguageDefinition {
  id: Language;
  extensions: readonly string[];
  /** @vscode/tree-sitter-wasm 中的 grammar 文件名。 */
  grammar?: string;
  /** 第三方 grammar 的绝对 wasm 路径；内置语言无需填写。 */
  grammarPath?: string;
  extractor?: ExtractorFamily;
  resolver?: ResolverFamily;
  embedded?: EmbeddedSourceKind;
}

const BUILTINS: readonly LanguageDefinition[] = [
  language("typescript", [".ts", ".mts", ".cts"], "typescript", "ts", "ts"),
  language("tsx", [".tsx"], "tsx", "ts", "ts"),
  language("javascript", [".js", ".mjs", ".cjs"], "javascript", "ts", "ts"),
  language("jsx", [".jsx"], "tsx", "ts", "ts"),
  embedded("vue", [".vue"]),
  embedded("svelte", [".svelte"]),
  embedded("astro", [".astro"]),
  language("python", [".py", ".pyi"], "python", "python", "python"),
  language("go", [".go"], "go", "go", "go"),
  language("rust", [".rs"], "rust", "rust", "rust"),

  // 依赖已分发 grammar 的语言先接入通用结构抽取器。它可以可靠给出声明
  // 和调用位置，但不会把不确定的模块路径伪装成完整解析。
  language("java", [".java"], "java", "generic"),
  language("c", [".c", ".h"], "cpp", "generic"),
  language("cpp", [".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"], "cpp", "generic"),
  language("csharp", [".cs"], "c-sharp", "generic"),
  language("php", [".php", ".phtml"], "php", "generic"),
  language("ruby", [".rb", ".rake", ".gemspec"], "ruby", "generic"),
  language("powershell", [".ps1", ".psm1", ".psd1"], "powershell", "generic"),
  language("shell", [".sh", ".bash", ".zsh", ".fish"], "bash", "generic"),

  // 暂无随包 grammar 的语言也必须作为源码可见：统计 LOC、展示源码并支持
  // 文件级 AI 理解；只是明确不产出符号/调用图。
  plain("kotlin", [".kt", ".kts"]),
  plain("swift", [".swift"]),
  plain("dart", [".dart"]),
  plain("lua", [".lua"]),
  plain("scala", [".scala", ".sc"]),
  plain("elixir", [".ex", ".exs"]),
  plain("erlang", [".erl", ".hrl"]),
  plain("haskell", [".hs", ".lhs"]),
  plain("clojure", [".clj", ".cljs", ".cljc", ".edn"]),
  plain("objective-c", [".m", ".mm"]),
  plain("groovy", [".groovy", ".gradle"]),
  plain("perl", [".pl", ".pm", ".t"]),
  plain("r", [".r", ".rmd"]),
  plain("zig", [".zig"]),
  plain("nim", [".nim", ".nims"]),
  plain("solidity", [".sol"]),
  plain("sql", [".sql"]),
  plain("html", [".html", ".htm"]),
  language("css", [".css"], "css", "generic"),
  plain("scss", [".scss", ".sass"]),
  plain("less", [".less"]),
  plain("graphql", [".graphql", ".gql"]),
  plain("protobuf", [".proto"]),
  plain("terraform", [".tf", ".tfvars"]),
  plain("json", [".json", ".jsonc"]),
  plain("yaml", [".yaml", ".yml"]),
  plain("toml", [".toml"]),
  plain("markdown", [".md", ".mdx"]),
];

const definitions = new Map<Language, LanguageDefinition>();
let extensions = new Map<string, Language>();

for (const definition of BUILTINS) definitions.set(definition.id, definition);
rebuildExtensions();

export function detectLanguage(path: string): Language {
  const lower = path.toLowerCase();
  // 复合后缀要求最长匹配；注册表重建时已经按长度排序。
  for (const [extension, id] of extensions) {
    if (lower.endsWith(extension)) return id;
  }
  return "other";
}

export function languageDefinition(language: Language): LanguageDefinition | undefined {
  return definitions.get(language);
}

export function languageDefinitions(): readonly LanguageDefinition[] {
  return [...definitions.values()];
}

/**
 * 注册第三方语言。ID 必须使用 `custom:` 命名空间；同一 ID 或后缀不会静默
 * 覆盖已有语言，避免插件加载顺序改变扫描结果。应在 scanRepo 前调用。
 */
export function registerLanguage(definition: LanguageDefinition): void {
  if (!definition.id.startsWith("custom:") || definition.id.length === "custom:".length) {
    throw new Error("自定义语言 ID 必须使用 custom:<name> 格式");
  }
  if (definitions.has(definition.id)) throw new Error(`语言已注册：${definition.id}`);
  const normalized = normalizeDefinition(definition);
  for (const extension of normalized.extensions) {
    const owner = extensions.get(extension);
    if (owner) throw new Error(`扩展名 ${extension} 已属于 ${owner}`);
  }
  if ((normalized.grammar || normalized.grammarPath) && !normalized.extractor) {
    throw new Error("提供 grammar 时必须同时声明 extractor");
  }
  if (normalized.extractor && !normalized.grammar && !normalized.grammarPath && !normalized.embedded) {
    throw new Error("提供 extractor 时必须同时声明 grammar 或 grammarPath");
  }
  definitions.set(normalized.id, normalized);
  rebuildExtensions();
}

export function isAnalyzable(language: Language): language is AnalyzableLanguage {
  const definition = definitions.get(language);
  return Boolean(definition?.extractor && (definition.grammar || definition.grammarPath || definition.embedded));
}

export function grammarFor(language: AnalyzableLanguage): string {
  const definition = definitions.get(language);
  if (!definition?.grammar && !definition?.grammarPath) {
    throw new Error(`语言 ${language} 没有直接 grammar`);
  }
  return definition.grammar ?? language.replace(/^custom:/, "");
}

export function grammarPathFor(language: AnalyzableLanguage): string | undefined {
  return definitions.get(language)?.grammarPath;
}

export function extractorFamily(language: AnalyzableLanguage): ExtractorFamily {
  const family = definitions.get(language)?.extractor;
  if (!family) throw new Error(`语言 ${language} 没有抽取器`);
  return family;
}

export function resolverFamily(language: Language): ResolverFamily | undefined {
  return definitions.get(language)?.resolver;
}

function language(
  id: BuiltinLanguage,
  fileExtensions: readonly string[],
  grammar: string,
  extractor: ExtractorFamily,
  resolver?: ResolverFamily,
): LanguageDefinition {
  return normalizeDefinition({ id, extensions: fileExtensions, grammar, extractor, resolver });
}

function embedded(id: EmbeddedSourceKind, fileExtensions: readonly string[]): LanguageDefinition {
  // 直接调用 ParserPool 时使用组件的默认脚本语法；扫描路径仍会依据 lang 属性
  // 切到 TypeScript/TSX。这样 AnalyzableLanguage 的公开契约不会出现可分析却无 grammar 的例外。
  const grammar = id === "astro" ? "typescript" : "javascript";
  return normalizeDefinition({
    id, extensions: fileExtensions, grammar, extractor: "ts", resolver: "ts", embedded: id,
  });
}

function plain(id: BuiltinLanguage, fileExtensions: readonly string[]): LanguageDefinition {
  return normalizeDefinition({ id, extensions: fileExtensions });
}

function normalizeDefinition(definition: LanguageDefinition): LanguageDefinition {
  const normalizedExtensions = [...new Set(definition.extensions.map((extension) => {
    const lower = extension.toLowerCase();
    return lower.startsWith(".") ? lower : `.${lower}`;
  }))];
  if (normalizedExtensions.length === 0) throw new Error(`语言 ${definition.id} 没有扩展名`);
  return { ...definition, extensions: normalizedExtensions };
}

function rebuildExtensions(): void {
  extensions = new Map(
    [...definitions.values()]
      .flatMap((definition) => definition.extensions.map((extension) => [extension, definition.id] as const))
      .sort(([a], [b]) => b.length - a.length),
  );
}
