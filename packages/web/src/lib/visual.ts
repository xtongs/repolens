import type { GraphNodeDto, Language, SymbolKind } from "@repolens/core/types";
import type { MetricKey } from "../store/useAppStore";

const LANGUAGE_COLORS: Record<string, string> = {
  typescript: "var(--lang-typescript)",
  tsx: "var(--lang-tsx)",
  javascript: "var(--lang-javascript)",
  jsx: "var(--lang-jsx)",
  python: "var(--lang-python)",
  go: "var(--lang-go)",
  rust: "var(--lang-rust)",
};

const NEUTRAL = "var(--lang-other)";

export function languageColor(language: Language | null | undefined): string {
  if (!language) return NEUTRAL;
  return LANGUAGE_COLORS[language] ?? NEUTRAL;
}

export function nodeAccent(node: GraphNodeDto): string {
  // 圆点、色条和 Tooltip 标记在全站只表达编程语言。架构层是模型推断，
  // 继续用文字标签呈现，不能覆盖语言颜色，否则同一种蓝色会同时表示
  // TypeScript 和某个 AI 架构层。
  if (node.kind === "external") return "var(--color-ink-faint)";
  if (node.kind === "aggregate") return "var(--color-ink-faint)";
  if (node.language) return languageColor(node.language);
  return "var(--color-ink-muted)";
}

export const METRIC_LABELS: Record<MetricKey, string> = {
  loc: "代码行",
  complexity: "复杂度",
  symbols: "符号数",
};

export function metricValue(node: GraphNodeDto, metric: MetricKey): number {
  switch (metric) {
    case "loc":
      return node.metrics.loc;
    case "complexity":
      return node.metrics.complexity;
    case "symbols":
      return node.metrics.symbols;
  }
}

/**
 * 节点尺寸按主指标缩放。
 *
 * 用平方根而不是线性映射：代码行数在仓库里的分布通常跨两个数量级，
 * 线性映射会让最大的那个节点吃掉整个画布。
 */
export function nodeSize(
  node: GraphNodeDto,
  metric: MetricKey,
  maxMetric: number,
): { width: number; height: number } {
  if (node.kind === "external") return { width: 150, height: 46 };

  const raw = metricValue(node, metric);
  const t = maxMetric > 0 ? Math.sqrt(Math.max(0, raw) / maxMetric) : 0;
  const metricWidth = 152 + 84 * t;
  const metadata = [
    formatCount(raw),
    node.layer ? `· ${node.layer}` : null,
    node.childCount > 0 && node.kind !== "symbol" ? `· ${node.childCount} 项` : null,
    node.metrics.inDegree + node.metrics.outDegree > 0
      ? `↓${node.metrics.outDegree} ↑${node.metrics.inDegree}`
      : null,
  ].filter((part): part is string => part !== null);

  // 第二行不允许换行，架构层也不能被截成「工具与配…」。节点原先只按
  // 指标决定宽度，小节点遇到长层名 + 子项数就装不下。这里按实际文案估算
  // 一个内容下限；指标仍然可以把重要节点放大，但不会再压缩元信息。
  const metadataWidth = metadata.reduce((sum, part) => sum + estimateLabelWidth(part), 0)
    + Math.max(0, metadata.length - 1) * 8
    + 28;
  return {
    width: Math.round(Math.max(metricWidth, metadataWidth)),
    height: Math.round(50 + 24 * t),
  };
}

/** 按 130% 最大字号档保守估算，切换字体大小后也不能重新发生裁切。 */
function estimateLabelWidth(value: string): number {
  let width = 0;
  for (const char of value) width += char.charCodeAt(0) > 0x7f ? 14 : 8;
  return width;
}

/**
 * 计算节点的显示名：同级包如果去掉 `@scope/` 后仍然互不相同，就去掉。
 *
 * `@earendil-works/pi-ai` 和 `@earendil-works/pi-tui` 在节点上都会被
 * 截断成 `@earendil-works/pi-…`，前缀占满了宽度却不携带任何区分信息。
 * 节点宽度由主指标编码，不能为了塞下前缀去加宽，所以只能把前缀拿掉。
 * 完整名字仍然保留在 hover 卡片和详情抽屉里。
 */
export function displayLabels(nodes: readonly GraphNodeDto[]): Map<string, string> {
  const out = new Map<string, string>();
  const scoped = nodes.filter((n) => n.kind === "package" && n.label.startsWith("@"));

  const stripped = new Map<string, string>();
  for (const node of scoped) {
    const slash = node.label.indexOf("/");
    if (slash > 0 && slash < node.label.length - 1) {
      stripped.set(node.id, node.label.slice(slash + 1));
    }
  }

  // 去掉前缀后出现重名就说明 scope 是必要的区分信息，整组都保留原样
  const shorts = [...stripped.values()];
  if (shorts.length > 0 && new Set(shorts).size === shorts.length) {
    for (const [id, short] of stripped) out.set(id, short);
  }

  for (const node of nodes) {
    if (!out.has(node.id)) out.set(node.id, node.label);
  }
  return out;
}

export function formatCount(value: number): string {
  if (value >= 10000) return `${(value / 1000).toFixed(0)}k`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(value);
}

const SYMBOL_GLYPHS: Partial<Record<SymbolKind, string>> = {
  function: "ƒ",
  method: "ƒ",
  class: "C",
  interface: "I",
  struct: "S",
  trait: "T",
  enum: "E",
  type: "T",
  impl: "◆",
  constant: "K",
  variable: "V",
  module: "M",
  property: "P",
};

export function symbolGlyph(kind: SymbolKind | null | undefined): string {
  if (!kind) return "·";
  return SYMBOL_GLYPHS[kind] ?? "·";
}

export function kindLabel(node: GraphNodeDto): string {
  switch (node.kind) {
    case "package":
      return "包";
    case "directory":
      return "目录";
    case "file":
      return "文件";
    case "symbol":
      return node.symbolKind ?? "符号";
    case "external":
      return "外部依赖";
    case "aggregate":
      return "折叠组";
  }
}
