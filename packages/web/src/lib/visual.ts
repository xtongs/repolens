import type { GraphNodeDto, Language, SymbolKind } from "@repolens/core/types";
import type { MetricKey } from "../store/useAppStore";

const LANGUAGE_COLORS: Record<string, string> = {
  typescript: "#4a9eff",
  tsx: "#4a9eff",
  javascript: "#e5c06b",
  jsx: "#e5c06b",
  python: "#5ecb9e",
  go: "#56c7d6",
  rust: "#e08758",
};

const NEUTRAL = "#8b95a5";

export function languageColor(language: Language | null | undefined): string {
  if (!language) return NEUTRAL;
  return LANGUAGE_COLORS[language] ?? NEUTRAL;
}

export function nodeAccent(node: GraphNodeDto): string {
  if (node.kind === "external") return "#6b7583";
  if (node.kind === "aggregate") return "#6b7583";
  if (node.layer) return layerColor(node.layer);
  if (node.language) return languageColor(node.language);
  return "#5f6b7d";
}

const LAYER_COLORS = ["#5eb0ff", "#5ecb9e", "#c58af9", "#e0a458", "#e08758", "#56c7d6"];

function layerColor(layer: string): string {
  let hash = 2166136261;
  for (let i = 0; i < layer.length; i++) {
    hash ^= layer.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return LAYER_COLORS[Math.abs(hash) % LAYER_COLORS.length] ?? "#5eb0ff";
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
  return {
    width: Math.round(152 + 84 * t),
    height: Math.round(50 + 24 * t),
  };
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
