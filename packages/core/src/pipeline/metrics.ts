import type { ParsedSymbol } from "../types.js";

/**
 * 代码行数统计。
 *
 * 统计的是「非空非纯注释行」，而不是文件总行数。理由是这个数字会直接编码成
 * 目录树的热力和图上节点的大小——把 200 行 license 头算进去，会让用户
 * 把注意力投到错误的地方。
 */
export function countLoc(source: string, language: string): number {
  const commentPrefixes = lineCommentPrefixes(language);
  const block = blockCommentDelimiters(language);

  let loc = 0;
  let inBlock = false;

  for (const rawLine of source.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    if (inBlock) {
      if (block && line.includes(block[1])) inBlock = false;
      continue;
    }

    if (block && line.startsWith(block[0])) {
      // 单行内开闭的块注释不进入块内状态
      if (!line.slice(block[0].length).includes(block[1])) inBlock = true;
      continue;
    }

    if (commentPrefixes.some((prefix) => line.startsWith(prefix))) continue;

    loc++;
  }

  return loc;
}

/**
 * 复杂度按 AST 子树数，嵌套在函数里、又自成符号的函数（内联路由 handler、
 * 组件里的局部函数）会同时算进外层，文件合计时重复计数。这里把每个函数扣成
 * 只算自己那部分，口径和 ESLint 的 complexity 规则一致。
 */
export function excludeNestedComplexity(symbols: readonly ParsedSymbol[]): ParsedSymbol[] {
  const functions = symbols
    .map((symbol, index) => ({ symbol, index }))
    .filter(({ symbol }) => symbol.kind === "function" || symbol.kind === "method");
  const own = symbols.map((symbol) => symbol.complexity);
  const span = (s: ParsedSymbol) => s.endByte - s.startByte;

  for (const inner of functions) {
    let parent: (typeof functions)[number] | null = null;
    for (const outer of functions) {
      const o = outer.symbol;
      const i = inner.symbol;
      if (outer === inner || o.startByte > i.startByte || i.endByte > o.endByte || span(o) === span(i)) continue;
      if (parent === null || span(o) < span(parent.symbol)) parent = outer;
    }
    if (parent !== null) own[parent.index]! -= inner.symbol.complexity - 1;
  }

  return symbols.map((symbol, index) =>
    own[index] === symbol.complexity ? symbol : { ...symbol, complexity: Math.max(1, own[index]!) });
}

function lineCommentPrefixes(language: string): string[] {
  switch (language) {
    case "python":
    case "yaml":
    case "shell":
    case "toml":
      return ["#"];
    default:
      return ["//"];
  }
}

function blockCommentDelimiters(language: string): [string, string] | null {
  switch (language) {
    case "python":
    case "yaml":
    case "shell":
    case "toml":
      return null;
    default:
      return ["/*", "*/"];
  }
}
