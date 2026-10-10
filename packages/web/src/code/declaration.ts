import type { CodeToken } from "../lib/highlight";

/** 解析器存签名时的上限，存满了说明原文被截断过 */
export const MAX_SIGNATURE = 400;

/**
 * 声明头在源码里占的范围：从符号起始行往下找，直到压掉空白后的文本盖住索引里的签名。
 * 索引存的签名是压成一行的（见 core 的 signatureOf），回到原文才能保留作者的换行和缩进。
 * 返回头部占几行、最后一行留到第几列（之后是函数体）；找不到时为 null。
 */
export function declarationHeader(
  lines: readonly string[],
  signature: string,
  maxLines = 40,
): { count: number; lastColumn: number } | null {
  if (signature === "") return null;
  for (let count = 1; count <= Math.min(lines.length, maxLines); count++) {
    const text = lines.slice(0, count).join("\n");
    const at = normalizeWhitespace(text).indexOf(signature);
    if (at < 0) continue;
    const end = rawOffset(text, at + signature.length);
    return { count, lastColumn: Math.max(0, end - (text.lastIndexOf("\n") + 1)) };
  }
  return null;
}

/** 压缩空白后的第 n 个字符在原文里的偏移 */
function rawOffset(text: string, normalizedEnd: number): number {
  let i = 0;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  let seen = 0;
  while (i < text.length && seen < normalizedEnd) {
    if (/\s/.test(text[i] as string)) {
      while (i < text.length && /\s/.test(text[i] as string)) i++;
    } else {
      i++;
    }
    seen++;
  }
  return i;
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

type Range = [number, number];

/**
 * 新旧两版签名各自改了哪几段：按词做最长公共子序列，没对上的词就是改动。
 * 按词而不是按字符，免得把一个标识符劈成两半；只隔着空白的改动并成一段。区间左闭右开。
 */
export function changedRanges(before: string, after: string): { before: Range[]; after: Range[] } {
  const a = tokenize(before);
  const b = tokenize(after);
  const width = b.length + 1;
  // lcs[i][j]：a[i..] 和 b[j..] 的最长公共子序列长度；签名最多几百字符，表不大
  const lcs = new Uint16Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i]?.text === b[j]?.text
        ? (lcs[(i + 1) * width + j + 1] as number) + 1
        : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number);
    }
  }
  const changedA: Token[] = [];
  const changedB: Token[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i]?.text === b[j]?.text) {
      i++;
      j++;
    } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
      changedA.push(a[i++] as Token);
    } else {
      changedB.push(b[j++] as Token);
    }
  }
  changedA.push(...a.slice(i));
  changedB.push(...b.slice(j));
  return { before: toRanges(before, changedA), after: toRanges(after, changedB) };
}

interface Token {
  text: string;
  start: number;
}

function tokenize(text: string): Token[] {
  return [...text.matchAll(/[\p{L}\p{N}_$]+|\s+|[^\s\p{L}\p{N}_$]/gu)].map((match) => ({ text: match[0], start: match.index }));
}

function toRanges(text: string, changed: readonly Token[]): Range[] {
  const ranges: Range[] = [];
  for (const token of changed) {
    if (token.text.trim() === "") continue;
    const end = token.start + token.text.length;
    const last = ranges.at(-1);
    if (last && text.slice(last[1], token.start).trim() === "") last[1] = end;
    else ranges.push([token.start, end]);
  }
  return ranges;
}

/** 取一行高亮 token 里 [from, to) 列的部分 */
export function sliceTokens(tokens: readonly CodeToken[], from: number, to = Infinity): CodeToken[] {
  const out: CodeToken[] = [];
  let offset = 0;
  for (const token of tokens) {
    const start = Math.max(from, offset);
    const end = Math.min(to, offset + token[0].length);
    if (end > start) out.push([token[0].slice(start - offset, end - offset), token[1], token[2]]);
    offset += token[0].length;
  }
  return out;
}

/** 各行共同的前导空白宽度；空行不参与 */
export function commonIndent(lines: readonly string[]): number {
  let indent = Infinity;
  for (const line of lines) {
    if (line.trim() === "") continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  return indent === Infinity ? 0 : indent;
}
