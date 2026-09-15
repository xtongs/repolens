import { useEffect, useState } from "react";
import { findNode } from "../graph/model";
import { formatCount, kindLabel, nodeAccent } from "../lib/visual";
import { useAppStore } from "../store/useAppStore";

const CARD_WIDTH = 268;
const OFFSET = 16;
/** 悬停多久才浮出卡片；太快会让掠过图面变成闪屏 */
const DELAY_MS = 180;

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
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (hovered === null) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [hovered]);

  if (hovered === null || anchor === null || !visible) return null;

  const node = findNode(subgraphs, hovered);
  if (!node) return null;

  const accent = nodeAccent(node);
  const left = Math.min(anchor.x + OFFSET, window.innerWidth - CARD_WIDTH - 12);
  const top = Math.min(anchor.y + OFFSET, window.innerHeight - 200);

  return (
    <div
      className="anim-fade pointer-events-none fixed z-50 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] p-3 shadow-2xl"
      style={{ left, top, width: CARD_WIDTH }}
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

      {node.summary && (
        <p className="mt-2 line-clamp-3 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
          {node.summary}
        </p>
      )}

      <div className="mt-2.5 grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
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
        <Stat label="依赖" value={`↓${node.metrics.inDegree} ↑${node.metrics.outDegree}`} />
      </div>

      {node.expandable && (
        <div className="mt-2.5 border-t border-[var(--color-line)] pt-2 text-[10.5px] text-[var(--color-ink-faint)]">
          双击展开 {node.childCount} 项 · ⌥双击 只看它的邻居
        </div>
      )}
    </div>
  );
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
