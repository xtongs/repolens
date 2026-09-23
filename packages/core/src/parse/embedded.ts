import type { AnalyzableLanguage, Language } from "../types.js";
import { languageDefinition } from "../discovery/language.js";

export interface PreparedSource {
  /** 与原文件 UTF-8 字节数和换行位置完全一致，可直接沿用 AST 的位置。 */
  source: string;
  parserLanguage: Exclude<AnalyzableLanguage, "vue" | "svelte" | "astro">;
}

/**
 * 把复合组件变成等长的虚拟 JS/TS 文件：保留脚本，模板、样式和标签本身
 * 换成空格，换行保持不动。这样 tree-sitter 的行号和字节偏移仍指向原文件。
 */
export function prepareSource(language: Language, source: string): PreparedSource | null {
  switch (languageDefinition(language)?.embedded) {
    case "vue":
    case "svelte":
      return scriptBlocks(source);
    case "astro":
      return astroFrontmatter(source);
    default:
      return null;
  }
}

function scriptBlocks(source: string): PreparedSource {
  const ranges: Array<{ start: number; end: number }> = [];
  let parserLanguage: PreparedSource["parserLanguage"] = "javascript";
  const tags = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

  for (const match of source.matchAll(tags)) {
    if (match.index === undefined) continue;
    const full = match[0];
    const attributes = match[1] ?? "";
    const body = match[2] ?? "";
    const bodyOffset = full.indexOf(">") + 1;
    const start = match.index + Math.max(0, bodyOffset);
    ranges.push({ start, end: start + body.length });

    const lang = attributeValue(attributes, "lang")?.toLowerCase();
    if (lang === "tsx" || lang === "jsx") parserLanguage = "tsx";
    else if ((lang === "ts" || lang === "typescript") && parserLanguage !== "tsx") {
      parserLanguage = "typescript";
    }
  }

  return { source: maskExcept(source, ranges), parserLanguage };
}

function astroFrontmatter(source: string): PreparedSource {
  // Astro frontmatter 必须从文件开头（允许 BOM）起始，第二个独占行的 --- 结束。
  const open = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!open) return { source: maskExcept(source, []), parserLanguage: "typescript" };
  const bodyStart = open[0].length;
  const close = /^---[ \t]*(?:\r?\n|$)/m.exec(source.slice(bodyStart));
  const bodyEnd = close ? bodyStart + (close.index ?? 0) : source.length;
  return {
    source: maskExcept(source, [{ start: bodyStart, end: bodyEnd }]),
    parserLanguage: "typescript",
  };
}

function attributeValue(attributes: string, name: string): string | null {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:\"([^\"]*)\"|'([^']*)'|([^\\s>]+))`, "i")
    .exec(attributes);
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? null;
}

/** UTF-8 字节级遮罩，避免中文模板把后续 AST 的 startIndex 推偏。 */
function maskExcept(source: string, charRanges: readonly { start: number; end: number }[]): string {
  const input = Buffer.from(source, "utf8");
  const output = Buffer.alloc(input.length, 0x20);
  for (let i = 0; i < input.length; i++) {
    if (input[i] === 0x0a || input[i] === 0x0d) output[i] = input[i] as number;
  }
  for (const range of charRanges) {
    const start = Buffer.byteLength(source.slice(0, range.start), "utf8");
    const end = start + Buffer.byteLength(source.slice(range.start, range.end), "utf8");
    input.copy(output, start, start, end);
  }
  return output.toString("utf8");
}
