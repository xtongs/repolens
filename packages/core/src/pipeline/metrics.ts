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
