/**
 * 单行超过这个长度多半是 base64、压缩代码或内联数据。整行发给模型读不出
 * 什么，却能一行吃掉大半预算，把后面真正的代码挤出去。
 */
export const MAX_SOURCE_LINE_CHARS = 400;
const ELIDED_LINE_KEEP = 120;
const ELIDED_LINE_MARK = /…（省略 \d+ 字符）$/m;

/**
 * 给源码加上「行号| 」前缀再交给模型。模型数不准行，只有把绝对行号
 * 明文写在每行开头，它标注的范围才可能对得上。超长的行只留开头并注明
 * 省略了多少，行号不受影响；超出预算时在整行处截断。
 */
export function numberSourceLines(text: string, firstLine: number, maxChars: number): string {
  const lines = text.split("\n");
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  const out: string[] = [];
  let used = 0;
  for (const [index, line] of lines.entries()) {
    const numbered = String(firstLine + index) + "| " + elideLongLine(line);
    if (out.length > 0 && used + numbered.length + 1 > maxChars) break;
    out.push(numbered);
    used += numbered.length + 1;
  }
  return out.join("\n");
}

function elideLongLine(line: string): string {
  if (line.length <= MAX_SOURCE_LINE_CHARS) return line;
  return `${line.slice(0, ELIDED_LINE_KEEP)}…（省略 ${line.length - ELIDED_LINE_KEEP} 字符）`;
}

/** numberSourceLines 的输出里是否有被缩短的行，用来决定要不要向模型解释这个标记 */
export function hasElidedLines(numbered: string): boolean {
  return ELIDED_LINE_MARK.test(numbered);
}
