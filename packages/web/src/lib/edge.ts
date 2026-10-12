/**
 * 图上一条边被选中时的「节点 id」：`edge:<from>→<to>`。和节点共用 selected，
 * Esc、关闭详情这些手势就不用为边另写一遍。箭头不会出现在节点 id 里。
 */
const PREFIX = "edge:";
const SEPARATOR = "\u2192";

export function edgeSelection(from: string, to: string): string {
  return `${PREFIX}${from}${SEPARATOR}${to}`;
}

export function parseEdgeSelection(id: string | null): { from: string; to: string } | null {
  if (id === null || !id.startsWith(PREFIX)) return null;
  const rest = id.slice(PREFIX.length);
  const at = rest.indexOf(SEPARATOR);
  if (at <= 0 || at === rest.length - 1) return null;
  return { from: rest.slice(0, at), to: rest.slice(at + SEPARATOR.length) };
}

/** 能当成「模块之间的契约」来看的端点：包、目录、文件 */
export function isContractEnd(id: string): boolean {
  return /^(?:pkg|dir|file):./.test(id);
}
