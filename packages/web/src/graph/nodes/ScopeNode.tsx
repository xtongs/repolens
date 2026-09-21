import type { GraphNodeDto } from "@repolens/core/types";
import { Handle, Position, type NodeProps, type Node } from "@xyflow/react";
import { memo } from "react";
import type { MetricKey } from "../../store/useAppStore";
import { formatCount, metricValue, nodeAccent, symbolGlyph } from "../../lib/visual";
import { CONTAINER_HEADER } from "../layout/useElkLayout";

export interface ScopeNodeData extends Record<string, unknown> {
  dto: GraphNodeDto;
  /** 去噪后的显示名，可能比 dto.label 短；完整名字留给 hover 卡片和抽屉 */
  label: string;
  metric: MetricKey;
  isContainer: boolean;
  selected: boolean;
  /** hover 高亮的主角 */
  active: boolean;
  /** hover 时与主角相邻，保持可读 */
  related: boolean;
  /** hover 时无关，衰减到 15% */
  dimmed: boolean;
  /** 缩放过小，切换到低细节渲染 */
  lowDetail: boolean;
  /** 横向布局（调用图），连接点挂左右而不是上下 */
  horizontal: boolean;
  truncatedInside: number;
}

export type ScopeNodeType = Node<ScopeNodeData, "scope">;

/**
 * 图上的通用节点。
 *
 * 一个组件覆盖包/目录/文件/符号四种类型，因为它们在视觉上只差
 * 一个类型标记和一个主指标——拆成四个组件只会让四处的 hover/选中
 * 状态实现出现细微差异。
 */
export const ScopeNode = memo(function ScopeNode({ data }: NodeProps<ScopeNodeType>) {
  const {
    dto,
    label,
    metric,
    isContainer,
    selected,
    active,
    related,
    dimmed,
    lowDetail,
    horizontal,
    truncatedInside,
  } = data;
  const accent = nodeAccent(dto);
  const value = metricValue(dto, metric);
  // 连接点要和布局方向一致，否则横向排布的边会先绕到节点顶部再兜回来
  const inPos = horizontal ? Position.Left : Position.Top;
  const outPos = horizontal ? Position.Right : Position.Bottom;

  // 衰减是为了让高亮那条链跳出来，不是为了把其余部分擦掉——
  // 压到看不见的话，用户就失去了「这条链在整体里的位置」这个上下文
  const opacity = dimmed ? 0.32 : 1;
  const scale = active ? 1.15 : 1;

  if (isContainer) {
    return (
      <div
        className="h-full w-full rounded-xl border transition-[opacity,box-shadow] duration-150"
        style={{
          opacity,
          borderColor: selected ? accent : "var(--color-line)",
          background: "color-mix(in srgb, var(--color-surface) 70%, transparent)",
          boxShadow: selected ? `0 0 0 1px ${accent}` : "none",
        }}
      >
        <Handle type="target" position={inPos} />
        <div
          className="flex items-center gap-2 px-3"
          style={{ height: CONTAINER_HEADER }}
        >
          <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: accent }} />
          <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
            {label}
          </span>
          <FindingsBadge dto={dto} inline />
          <span className="ml-auto shrink-0 text-[11px] text-[var(--color-ink-faint)]">
            {formatCount(value)}
          </span>
        </div>
        {truncatedInside > 0 && (
          <div className="absolute bottom-1.5 right-2.5 text-[10px] text-[var(--color-ink-faint)]">
            另有 {truncatedInside} 项未展开
          </div>
        )}
        <Handle type="source" position={outPos} />
      </div>
    );
  }

  const stackDepth = stackLayers(dto);

  return (
    <div
      className="relative h-full w-full"
      style={{
        opacity,
        transform: `scale(${scale})`,
        transformOrigin: "center",
        transition: "transform 140ms cubic-bezier(0.22,0.61,0.36,1), opacity 140ms ease",
        zIndex: active ? 10 : undefined,
      }}
    >
      <Handle type="target" position={inPos} />

      {/*
        层叠卡片：可展开但尚未展开的节点渲染成微微错位的几层，
        同时传达「这里有东西」「有多少」「可以展开」三件事。
        见 docs/INTERACTION.md「折叠与堆叠」。
      */}
      {stackDepth > 0 &&
        Array.from({ length: stackDepth }, (_, i) => i + 1).map((layer) => (
          <div
            key={layer}
            className="absolute inset-0 rounded-[10px] border"
            style={{
              transform: active
                ? `translate(${layer * 7}px, ${layer * 7}px) rotate(${layer * 0.6}deg)`
                : `translate(${layer * 3}px, ${layer * 3}px)`,
              borderColor: "var(--color-line)",
              background: "var(--color-surface)",
              opacity: 0.55 - layer * 0.12,
              transition: "transform 160ms cubic-bezier(0.22,0.61,0.36,1)",
              zIndex: -layer,
            }}
          />
        ))}

      {/*
        调用图的中心节点画一圈外环。展开两跳之后画面上全是同构的函数卡片，
        没有这个锚点就找不到自己是从哪个函数出发的。
      */}
      <div
        className="relative flex h-full w-full flex-col justify-center gap-1 overflow-hidden rounded-[10px] border px-3"
        style={{
          borderColor: dto.focus
            ? accent
            : selected
              ? accent
              : related
                ? "var(--color-line-strong)"
                : "var(--color-line)",
          background:
            selected || dto.focus
              ? `color-mix(in srgb, ${accent} 12%, var(--color-surface))`
              : "var(--color-surface)",
          boxShadow: dto.focus
            ? `0 0 0 1px ${accent}, 0 0 0 5px color-mix(in srgb, ${accent} 22%, transparent)`
            : selected
              ? `0 0 0 1px ${accent}`
              : active
                ? "var(--node-hover-shadow)"
                : "none",
        }}
      >
        <span
          className="absolute left-0 top-0 h-full w-[3px]"
          style={{ background: accent, opacity: dto.kind === "external" ? 0.4 : 0.85 }}
        />

        <FindingsBadge dto={dto} />

        {lowDetail ? (
          <span className="truncate text-[15px] font-semibold" style={{ color: accent }}>
            {label.slice(0, 2)}
          </span>
        ) : (
          <>
            <div className="flex items-baseline gap-1.5">
              {dto.kind === "symbol" && (
                <span className="mono shrink-0 text-[11px]" style={{ color: accent }}>
                  {symbolGlyph(dto.symbolKind)}
                </span>
              )}
              <span className="truncate text-[13px] font-medium text-[var(--color-ink)]">
                {label}
              </span>
            </div>
            <div className="flex min-w-0 flex-nowrap items-center gap-2 whitespace-nowrap text-[10.5px] text-[var(--color-ink-faint)]">
              <span className="shrink-0">{formatCount(value)}</span>
              {dto.layer && <span className="shrink-0 text-[var(--color-accent)]">· {dto.layer}</span>}
              {dto.childCount > 0 && dto.kind !== "symbol" && (
                <span className="shrink-0 text-[var(--color-ink-faint)]">· {dto.childCount} 项</span>
              )}
              {dto.metrics.inDegree + dto.metrics.outDegree > 0 && (
                <span
                  className="ml-auto shrink-0 tabular-nums"
                  title={dto.kind === "symbol" ? "调用 / 被调用" : "依赖 / 被依赖"}
                >
                  {horizontal
                    ? `→${dto.metrics.outDegree} ←${dto.metrics.inDegree}`
                    : `↓${dto.metrics.outDegree} ↑${dto.metrics.inDegree}`}
                </span>
              )}
            </div>
          </>
        )}
      </div>

      <Handle type="source" position={outPos} />
    </div>
  );
});

/** 层叠层数按子项数量分档，最多三层——再多就只是视觉噪音 */
function stackLayers(dto: GraphNodeDto): number {
  if (!dto.expandable) return 0;
  if (dto.childCount >= 12) return 3;
  if (dto.childCount >= 4) return 2;
  if (dto.childCount >= 1) return 1;
  return 0;
}

/**
 * 体检角标。
 *
 * 刻意只画一个点加一个数字：它的职责是「这儿值得看一眼」，具体是什么问题
 * 去左侧体检清单或详情里读。在节点上铺文字会把图变成报表，而图的价值恰恰
 * 在于一眼扫过去的形状。
 *
 * 计数含子孙上卷，所以在包级视图就能看出问题集中在哪个包。
 */
function FindingsBadge({ dto, inline }: { dto: GraphNodeDto; inline?: boolean }) {
  const findings = dto.findings;
  if (!findings || findings.count === 0) return null;

  const color = findings.high > 0 ? "var(--color-danger)" : "var(--color-warn)";
  const position = inline ? "shrink-0" : "absolute right-1.5 top-1.5";

  return (
    <span
      className={`${position} flex items-center gap-0.5 rounded-full px-1 text-[9.5px] font-medium tabular-nums`}
      style={{ background: `color-mix(in srgb, ${color} 20%, transparent)`, color }}
      title={`${findings.count} 处结构问题${findings.high > 0 ? `（${findings.high} 处需优先看）` : ""}`}
    >
      <span className="h-1 w-1 rounded-full" style={{ background: color }} />
      {findings.count}
    </span>
  );
}
