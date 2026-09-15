import { createRequire } from "node:module";
import { Language as TsLanguage, Parser } from "web-tree-sitter";
import type { AnalyzableLanguage } from "../types.js";
import { grammarFor } from "../discovery/language.js";

const require = createRequire(import.meta.url);

/**
 * tree-sitter 解析器池。
 *
 * 语法（Language）加载一次全程复用，Parser 实例按语法缓存——
 * 每次解析新建 Parser 会反复付 wasm 初始化的代价，在 1400 文件规模下很可观。
 * Tree 对象必须显式 delete，否则 wasm 堆会一直涨。
 */
export class ParserPool {
  private initialized = false;
  private readonly languages = new Map<string, TsLanguage>();
  private readonly parsers = new Map<string, Parser>();
  private readonly failed = new Set<string>();

  async init(): Promise<void> {
    if (this.initialized) return;
    await Parser.init();
    this.initialized = true;
  }

  async parserFor(language: AnalyzableLanguage): Promise<Parser | null> {
    const grammar = grammarFor(language);
    if (this.failed.has(grammar)) return null;

    const cached = this.parsers.get(grammar);
    if (cached) return cached;

    await this.init();

    try {
      let lang = this.languages.get(grammar);
      if (!lang) {
        lang = await TsLanguage.load(wasmPath(grammar));
        this.languages.set(grammar, lang);
      }
      const parser = new Parser();
      parser.setLanguage(lang);
      this.parsers.set(grammar, parser);
      return parser;
    } catch (err) {
      // 单个语法加载失败不该让整次扫描挂掉，记下来跳过该语言
      this.failed.add(grammar);
      process.emitWarning(
        `tree-sitter 语法 ${grammar} 加载失败，该语言将被跳过：${(err as Error).message}`,
      );
      return null;
    }
  }

  dispose(): void {
    for (const parser of this.parsers.values()) parser.delete();
    this.parsers.clear();
    this.languages.clear();
  }
}

function wasmPath(grammar: string): string {
  // 以 package.json 为锚点解析，避免依赖 @vscode/tree-sitter-wasm 的内部导出映射
  const anchor = require.resolve("@vscode/tree-sitter-wasm/package.json");
  const pkgDir = anchor.slice(0, anchor.lastIndexOf("/"));
  return `${pkgDir}/wasm/tree-sitter-${grammar}.wasm`;
}
