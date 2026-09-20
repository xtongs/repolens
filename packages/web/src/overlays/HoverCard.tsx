import type { GraphNodeDto, SemanticResultDto } from "@repolens/core/types";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { findNode } from "../graph/model";
import { formatCount, kindLabel, nodeAccent } from "../lib/visual";
import { useAppStore } from "../store/useAppStore";

const CARD_WIDTH = 440;
const VIEWPORT_MARGIN = 12;
const OFFSET = 16;
/** 悬停多久才浮出卡片；太快会让掠过图面变成闪屏 */
const DELAY_MS = 180;

type SemanticState =
  | { key: string; status: "loading"; value: HoverSemantic | null }
  | { key: string; status: "ready"; value: HoverSemantic }
  | { key: string; status: "error"; value: HoverSemantic | null };

interface HoverSemantic {
  shortSummary: string | null;
  pseudocode: string | null;
  incoming: number;
  outgoing: number;
}

const semanticCache = new Map<string, HoverSemantic>();
const semanticRequests = new Map<string, Promise<HoverSemantic>>();

/**
 * hover 预览卡片。
 *
 * 「隐藏」策略的主要载体：节点上只留名字和一个数字，其余信息全部
 * 推迟到这张卡片里，用户不必点击就能判断值不值得深入。
 */
export function HoverCard() {
  const hovered = useAppStore((s) => s.hovered);
  const anchor = useAppStore((s) => s.hoverAnchor);
  const metric = useAppStore((s) => s.metric);
  const subgraphs = useAppStore((s) => s.subgraphs);
  const repoId = useAppStore((s) => s.repoId);
  const [visible, setVisible] = useState(false);
  const [semantic, setSemantic] = useState<SemanticState | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const [measuredPosition, setMeasuredPosition] = useState<{
    key: string; left: number; top: number;
  } | null>(null);

  useEffect(() => {
    if (hovered === null) {
      setVisible(false);
      return;
    }
    setVisible(false);
    const timer = window.setTimeout(() => setVisible(true), DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hovered]);

  const node = hovered === null ? null : findNode(subgraphs, hovered);
  const semanticKey = node && (node.kind === "file" || node.kind === "symbol")
    ? `${repoId ?? "default"}:${node.id}`
    : null;

  // Tooltip 真正出现后才触发，掠过节点不会产生模型请求。文件和符号都在
  // 第一次有效悬停时补齐单句摘要与伪代码，之后从 DB 或内存缓存读取。
  useEffect(() => {
    if (!visible || !node || semanticKey === null) {
      setSemantic(null);
      return;
    }

    const embedded = semanticFromNode(node);
    const memory = semanticCache.get(semanticKey);
    const initial = completeSemantic(memory) ? memory : completeSemantic(embedded) ? embedded : null;
    if (initial) {
      semanticCache.set(semanticKey, initial);
      setSemantic({ key: semanticKey, status: "ready", value: initial });
      return;
    }

    let cancelled = false;
    setSemantic({ key: semanticKey, status: "loading", value: memory ?? embedded });
    const request = semanticRequests.get(semanticKey) ?? loadSemantic(node);
    semanticRequests.set(semanticKey, request);
    void request
      .then((value) => {
        semanticCache.set(semanticKey, value);
        if (!cancelled) setSemantic({ key: semanticKey, status: "ready", value });
      })
      .catch(() => {
        if (!cancelled) setSemantic({ key: semanticKey, status: "error", value: memory ?? embedded });
      })
      .finally(() => semanticRequests.delete(semanticKey));
    return () => {
      cancelled = true;
    };
  }, [visible, semanticKey]);

  const activeSemantic = semantic?.key === semanticKey ? semantic : null;
  const shortSummary = node
    ? activeSemantic?.value?.shortSummary ??
      ((node.kind === "file" || node.kind === "symbol") ? conciseSummary(node.summary) : node.summary)
    : null;
  const pseudocode = activeSemantic?.value?.pseudocode ?? null;
  const incoming = activeSemantic?.value?.incoming ?? node?.metrics.inDegree ?? 0;
  const outgoing = activeSemantic?.value?.outgoing ?? node?.metrics.outDegree ?? 0;
  const pseudocodeWidth = preferredPseudocodeWidth(pseudocode);

  // Tooltip 不接收鼠标事件，因此不能依赖内部滚动。内容变化后量出完整
  // 高度，优先放在指针下方，放不下就翻到上方，并夹在视口边界内。
  useLayoutEffect(() => {
    const card = cardRef.current;
    if (!visible || !hovered || !anchor || !card) return;
    const rect = card.getBoundingClientRect();
    let left = anchor.x + OFFSET;
    if (left + rect.width > window.innerWidth - VIEWPORT_MARGIN) {
      left = anchor.x - rect.width - OFFSET;
    }
    left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(left, Math.max(VIEWPORT_MARGIN, window.innerWidth - rect.width - VIEWPORT_MARGIN)),
    );

    let top = anchor.y + OFFSET;
    if (top + rect.height > window.innerHeight - VIEWPORT_MARGIN) {
      top = anchor.y - rect.height - OFFSET;
    }
    top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(top, Math.max(VIEWPORT_MARGIN, window.innerHeight - rect.height - VIEWPORT_MARGIN)),
    );
    setMeasuredPosition({ key: hovered, left, top });
  }, [visible, hovered, anchor?.x, anchor?.y, shortSummary, pseudocode, activeSemantic?.status]);

  if (hovered === null || anchor === null || !visible) return null;
  if (!node) return null;

  const accent = nodeAccent(node);
  const width = Math.min(CARD_WIDTH, window.innerWidth - VIEWPORT_MARGIN * 2);
  const fallbackLeft = Math.max(
    VIEWPORT_MARGIN,
    Math.min(anchor.x + OFFSET, window.innerWidth - width - VIEWPORT_MARGIN),
  );
  const position = measuredPosition?.key === hovered
    ? measuredPosition
    : { left: fallbackLeft, top: Math.max(VIEWPORT_MARGIN, anchor.y + OFFSET) };

  return (
    <div
      ref={cardRef}
      className="anim-fade pointer-events-none fixed z-50 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 shadow-2xl"
      style={{ left: position.left, top: position.top, width: Math.max(width, pseudocodeWidth) }}
    >
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
        <span className="truncate text-[13px] font-medium">{node.label}</span>
        <span className="ml-auto shrink-0 text-[10px] uppercase tracking-wide text-[var(--color-ink-faint)]">
          {kindLabel(node)}
        </span>
      </div>

      {node.path && (
        <div className="mono mt-1.5 truncate text-[10.5px] text-[var(--color-ink-faint)]">
          {node.path}
        </div>
      )}

      {node.layer && (
        <div className="mt-1.5 text-[10px] text-[var(--color-accent)]">AI 架构层 · {node.layer}</div>
      )}

      {shortSummary && (
        <div className="mt-2">
          <p className="line-clamp-2 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {shortSummary}
          </p>
        </div>
      )}

      {activeSemantic?.status === "loading" && (
        <div className="mt-2 flex items-center gap-2 rounded border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5 px-2 py-1.5 text-[10.5px] text-[var(--color-ink-muted)]">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--color-accent)]" />
          {node.kind === "file" ? "正在生成文件摘要与整体伪代码…" : "正在生成函数摘要与伪代码…"}
        </div>
      )}

      {activeSemantic?.status === "error" && (
        <div className="mt-2 text-[10.5px] text-[var(--color-warn)]">AI 内容生成失败，稍后再次悬停可重试</div>
      )}

      {pseudocode && (
        <div className="mt-2">
          <pre className="mono whitespace-pre rounded border border-[var(--color-line)] bg-[var(--color-canvas)]/60 p-2 text-[10.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {pseudocode}
          </pre>
        </div>
      )}

      <div className="mt-2.5 grid grid-cols-3 gap-x-3 gap-y-1 text-[11px]">
        <Stat label="代码行" value={formatCount(node.metrics.loc)} emphasized={metric === "loc"} />
        <Stat
          label="复杂度"
          value={formatCount(node.metrics.complexity)}
          emphasized={metric === "complexity"}
        />
        <Stat
          label="符号"
          value={formatCount(node.metrics.symbols)}
          emphasized={metric === "symbols"}
        />
        <Stat label={node.kind === "symbol" ? "调用" : "依赖"} value={String(outgoing)} />
        <Stat label={node.kind === "symbol" ? "被调用" : "被依赖"} value={String(incoming)} />
      </div>

      {node.expandable && (
        <div className="mt-2.5 border-t border-[var(--color-line)] pt-2 text-[10.5px] text-[var(--color-ink-faint)]">
          双击展开 {node.childCount} 项 · ⌥双击 只看它的邻居
        </div>
      )}
    </div>
  );
}

function semanticFromNode(node: GraphNodeDto): HoverSemantic {
  return {
    shortSummary: conciseSummary(node.summary), pseudocode: null,
    incoming: node.metrics.inDegree, outgoing: node.metrics.outDegree,
  };
}

function completeSemantic(value: HoverSemantic | null | undefined): value is HoverSemantic {
  return Boolean(value?.shortSummary && value.pseudocode);
}

async function loadSemantic(node: GraphNodeDto): Promise<HoverSemantic> {
  let detailSummary: string | null | undefined;
  let detailShortSummary: string | null | undefined;
  let detailPseudocode: string | null | undefined;
  let counts: { incoming: number; outgoing: number };
  if (node.kind === "file") {
    const detail = await api.file(node.id);
    detailSummary = detail.summary;
    detailShortSummary = detail.shortSummary;
    detailPseudocode = detail.pseudocode;
    counts = { incoming: detail.importedBy.length, outgoing: detail.imports.length };
  } else {
    const detail = await api.symbol(node.id);
    detailSummary = detail.summary;
    detailShortSummary = detail.shortSummary;
    detailPseudocode = detail.pseudocode;
    counts = { incoming: detail.callers.length, outgoing: detail.callees.length };
  }
  const cached = {
    shortSummary: detailShortSummary ?? conciseSummary(detailSummary),
    pseudocode: detailPseudocode ?? null,
    ...counts,
  };
  if (completeSemantic(cached)) return cached;
  const generated: SemanticResultDto = node.kind === "file"
    ? await api.generateFileSummary(node.id)
    : await api.generateSymbolSemantics(node.id);
  const value = {
    shortSummary: generated.shortSummary ?? conciseSummary(generated.summary),
    pseudocode: generated.pseudocode ?? null,
    ...counts,
  };
  if (!completeSemantic(value)) throw new Error("语义结果不完整");
  return value;
}

function preferredPseudocodeWidth(value: string | null): number {
  if (!value) return CARD_WIDTH;
  const longest = Math.max(...value.split("\n").map((line) => visualColumns(line)));
  // 10.5px 等宽字在当前字体下英文约 6.5px，中文约 13px。留 42px 给
  // 卡片和 pre 的两层 padding；最终仍夹在视口内。
  return Math.min(
    window.innerWidth - VIEWPORT_MARGIN * 2,
    Math.max(CARD_WIDTH, Math.ceil(longest * 6.8 + 42)),
  );
}

function visualColumns(value: string): number {
  let columns = 0;
  for (const char of value) columns += char.codePointAt(0)! > 0xff ? 2 : 1;
  return columns;
}

function conciseSummary(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(/\n\s*\n|\n/)[0]?.replace(/^(用途|Purpose)[:：]\s*/i, "").trim();
  if (!first) return null;
  const sentence = /^(.{1,160}?[。！？.!?])(?:\s|$)/u.exec(first)?.[1] ?? first;
  return sentence.length > 160 ? `${sentence.slice(0, 159)}…` : sentence;
}

function Stat({
  label,
  value,
  emphasized,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="text-[var(--color-ink-faint)]">{label}</span>
      <span
        className="tabular-nums"
        style={{ color: emphasized ? "var(--color-accent)" : "var(--color-ink-muted)" }}
      >
        {value}
      </span>
    </div>
  );
}
