import type { GraphNodeDto } from "@repolens/core/types";
import {
  Background,
  BackgroundVariant,
  Controls,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  useStore as useFlowStore,
  type Edge,
  type NodeMouseHandler,
  type Viewport,
} from "@xyflow/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HoverCard } from "../overlays/HoverCard";
import { NodeContextMenu, type ContextMenuState } from "../overlays/NodeContextMenu";
import { useAppStore, useGraphSlice, type MetricKey } from "../store/useAppStore";
import { displayLabels, metricValue, nodeAccent } from "../lib/visual";
import { applyFocus, flattenGraph, incidentEdgeIds, neighborIds } from "./model";
import { nodeSize } from "../lib/visual";
import { ScopeNode, type ScopeNodeType } from "./nodes/ScopeNode";
import { useElkLayout, type PositionedNode } from "./layout/useElkLayout";

const NODE_TYPES = { scope: ScopeNode };
const EDGE_DOT_MARKER = "repolens-edge-dot";
const ACTIVE_EDGE_DOT_MARKER = "repolens-active-edge-dot";

/** 缩放低于这个值就切低细节渲染，避免小字糊成一片 */
const LOW_DETAIL_ZOOM = 0.45;

/** 适配视口时留出的边距比例，两侧各算一次 */
const FIT_PADDING = 0.09;
/**
 * 适配时不放大超过 1 倍。节点的字号、圆角、间距都是按 1 倍设计的，
 * 小图放大到 2 倍会得到一堆糊掉的巨型卡片。
 */
const FIT_MAX_ZOOM = 1;
/**
 * 自动适配时不会缩到比这更小。
 *
 * 装不下的时候，让用户看清一部分比看到一整片噪点有用——低于这个
 * 缩放节点上的文字已经不可读，"看到全貌"也就没有意义了。
 */
const FIT_MIN_ZOOM = 0.5;
const FIT_DURATION = 320;
/** 两次点击间隔在这个窗口内算双击，与系统默认值大致一致 */
const DOUBLE_CLICK_MS = 320;

export function GraphCanvas() {
  return (
    <ReactFlowProvider>
      <CanvasInner />
    </ReactFlowProvider>
  );
}

function CanvasInner() {
  const slice = useGraphSlice();
  const focus = useAppStore((s) => s.focus);
  const focusDepth = useAppStore((s) => s.focusDepth);
  const metric = useAppStore((s) => s.metric);
  const hovered = useAppStore((s) => s.hovered);
  const selected = useAppStore((s) => s.selected);
  const loading = useAppStore((s) => s.loadingScopes.length > 0);
  // zustand 里的动作定义一次就不再变，单独取出来可以让下面的
  // useCallback 真正稳定下来
  const hover = useAppStore((s) => s.hover);
  const select = useAppStore((s) => s.select);
  const toggleExpand = useAppStore((s) => s.toggleExpand);
  const setFocus = useAppStore((s) => s.setFocus);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const openCallGraph = useAppStore((s) => s.openCallGraph);
  const callGraph = useAppStore((s) => s.callGraph);
  const revealed = useAppStore((s) => s.revealed);
  const clearRevealed = useAppStore((s) => s.clearRevealed);

  const zoom = useFlowStore((s) => s.transform[2]);
  const [menu, setMenu] = useState<ContextMenuState | null>(null);

  const flat = useMemo(
    () => applyFocus(flattenGraph(slice), focus, focusDepth),
    [slice, focus, focusDepth],
  );

  const maxMetric = useMemo(
    () => Math.max(1, ...flat.nodes.map((n) => metricValue(n.dto, metric))),
    [flat.nodes, metric],
  );

  const sizeOf = useCallback(
    (node: { dto: GraphNodeDto }) => nodeSize(node.dto, metric, maxMetric),
    [metric, maxMetric],
  );

  const horizontal = callGraph !== null;
  const layout = useElkLayout(flat, sizeOf, horizontal ? "RIGHT" : "DOWN");

  const lowDetail = zoom < LOW_DETAIL_ZOOM;

  const highlight = useMemo(() => {
    if (hovered === null) return null;
    // 缩得太远时高亮本来就读不出来，衰减只会把整张图变成一片黑
    if (lowDetail) return null;
    return {
      neighbors: neighborIds(flat.edges, hovered),
      edges: incidentEdgeIds(flat.edges, hovered),
    };
  }, [hovered, flat.edges, lowDetail]);

  // 视口跟着注意力走。结构图里注意力在刚展开的节点上；调用图里节点集合
  // 会随跳数整体换掉，锚点只能是那个不变的中心符号——否则调到 2 跳时
  // 扇出的几十个节点会把镜头拽走，出发点反而跑到屏幕外。
  // reveal 的目标优先：它是用户刚刚明确点过去的东西，比「最近展开的作用域」
  // 更接近注意力所在。展开链的最后一层往往是目标的父作用域，只框住它的话
  // 目标本身可能落在容器边缘，甚至在屏幕外。
  const attention = revealed ?? (callGraph ? `sym:${callGraph.symbolId}` : (slice.expanded.at(-1) ?? null));
  useAutoViewport(layout.nodes, layout.version, attention);

  // 消费掉，否则之后每次布局都会被拽回这个节点
  useEffect(() => {
    if (revealed !== null) clearRevealed();
  }, [revealed, clearRevealed]);

  const labels = useMemo(() => displayLabels(flat.nodes.map((n) => n.dto)), [flat.nodes]);

  const nodes = useMemo<ScopeNodeType[]>(
    () =>
      layout.nodes.map((node) =>
        toFlowNode(node, {
          metric,
          selected,
          hovered,
          highlight,
          lowDetail,
          labels,
          horizontal,
          truncatedByScope: flat.truncatedByScope,
        }),
      ),
    [
      layout.nodes,
      metric,
      selected,
      hovered,
      highlight,
      lowDetail,
      labels,
      horizontal,
      flat.truncatedByScope,
    ],
  );

  const edges = useMemo<Edge[]>(
    () =>
      flat.edges.map((edge) => {
        const active = highlight?.edges.has(edge.id) ?? false;
        const dimmed = highlight !== null && !active;
        const isUncertain = edge.confidence === "ambiguous" || edge.confidence === "likely";
        const color = active ? "var(--color-accent)" : "var(--color-line-strong)";
        return {
          id: edge.id,
          source: edge.source,
          target: edge.target,
          animated: false,
          style: {
            // 边宽编码依赖强度，最细也要 1px 否则在暗色背景上会消失
            strokeWidth: 1 + edge.weight * 2.4,
            stroke: color,
            strokeDasharray:
              edge.confidence === "ambiguous" ? "2 4" : edge.confidence === "likely" ? "6 4" : undefined,
            opacity: dimmed ? 0.2 : isUncertain ? 0.7 : 0.95,
            strokeLinecap: "round",
            transition: "opacity 140ms ease, stroke 140ms ease",
          },
          // 自定义实心圆使用 userSpaceOnUse，不会跟随依赖线宽放大。
          markerEnd: active ? ACTIVE_EDGE_DOT_MARKER : EDGE_DOT_MARKER,
          zIndex: active ? 5 : 0,
        };
      }),
    [flat.edges, highlight],
  );

  const onNodeEnter = useCallback<NodeMouseHandler<ScopeNodeType>>(
    (event, node) => {
      hover(node.id, { x: event.clientX, y: event.clientY });
    },
    [hover],
  );

  const onNodeLeave = useCallback<NodeMouseHandler<ScopeNodeType>>(() => {
    hover(null);
  }, [hover]);

  const lastClick = useRef<{ id: string; at: number } | null>(null);

  /**
   * 单击选中、双击展开都走这里。
   *
   * 不用 React Flow 的 onNodeDoubleClick：浏览器只在两次点击命中
   * 同一个元素时才合成 dblclick，而主线程一忙（大仓库首次布局就会）
   * 节点元素可能在两击之间被重建，手势就这么丢了。双击是本产品最
   * 核心的手势，不能挂在这种条件上。
   */
  const onNodeClick = useCallback<NodeMouseHandler<ScopeNodeType>>(
    (event, node) => {
      const now = event.timeStamp;
      const prev = lastClick.current;
      const isSecond = prev !== null && prev.id === node.id && now - prev.at <= DOUBLE_CLICK_MS;
      // 连点三次不该被算成两轮双击，命中后立刻清空
      lastClick.current = isSecond ? null : { id: node.id, at: now };

      if (!isSecond) {
        select(node.id);
        return;
      }

      // 第一击已经把抽屉推开了，但双击的意图是导航而不是查看细节，
      // 让它继续占着 400px 正好挡住刚展开的内容
      setDrawerOpen(false);

      if (event.altKey) {
        setFocus(focus === node.id ? null : node.id);
        return;
      }

      // 调用图里符号节点没有「下一层」可展开，双击的自然含义变成
      // 「以它为新的中心」——沿着调用链一路走下去，这是看懂一条链路的走法
      const dto = node.data.dto;
      if (callGraph && dto.kind === "symbol") {
        void openCallGraph(Number(dto.id.slice("sym:".length)), dto.label);
        return;
      }
      void toggleExpand(dto);
    },
    [select, setDrawerOpen, setFocus, toggleExpand, focus, callGraph, openCallGraph],
  );

  const onNodeContextMenu = useCallback<NodeMouseHandler<ScopeNodeType>>(
    (event, node) => {
      event.preventDefault();
      setMenu({ node: node.data.dto, x: event.clientX, y: event.clientY });
    },
    [],
  );

  if (flat.nodes.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-ink-faint)]">
        {loading ? "正在加载图谱…" : "这个作用域下没有可显示的内容"}
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <EdgeDotMarkers />
      <ReactFlow<ScopeNodeType>
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeMouseEnter={onNodeEnter}
        onNodeMouseLeave={onNodeLeave}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={() => {
          select(null);
          setMenu(null);
        }}
        onMoveStart={() => setMenu(null)}
        minZoom={0.15}
        maxZoom={2.2}
        proOptions={{ hideAttribution: true }}
        nodesDraggable
        nodesConnectable={false}
        elementsSelectable={false}
        zoomOnDoubleClick={false}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={22}
          size={1}
          color="var(--color-graph-grid)"
        />
        <Controls
          showInteractive={false}
          className="!border-[var(--color-line)] !bg-[var(--color-surface)]"
        />
      </ReactFlow>

      {layout.pending && (
        <div className="pointer-events-none absolute left-1/2 top-4 -translate-x-1/2 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)] px-3 py-1 text-[11px] text-[var(--color-ink-muted)]">
          正在布局…
        </div>
      )}

      <div className="pointer-events-none absolute bottom-4 right-4 rounded-full border border-[var(--color-line)] bg-[var(--color-surface)]/90 px-2.5 py-1 text-[10px] text-[var(--color-ink-faint)] shadow-sm backdrop-blur">
        {horizontal ? "调用方向：调用方 → 被调用方" : "依赖方向：使用方 ↓ 被依赖方"}
      </div>

      <HoverCard />
      {menu && <NodeContextMenu state={menu} onClose={() => setMenu(null)} />}
    </div>
  );
}

/**
 * 连接线末端只表达方向，不再用视觉重量很强的三角箭头。marker 的视口仍是
 * 原来的 13×13，圆点直径与旧箭头高度接近，并且与线宽完全解耦。
 */
function EdgeDotMarkers() {
  return (
    <svg aria-hidden="true" className="pointer-events-none absolute h-0 w-0">
      <defs>
        <marker
          id={EDGE_DOT_MARKER}
          markerWidth="13"
          markerHeight="13"
          markerUnits="userSpaceOnUse"
          orient="auto"
          refX="0"
          refY="0"
          viewBox="-9 -6.5 13 13"
        >
          <circle cx="-4.5" cy="0" r="4" fill="var(--color-line-strong)" />
        </marker>
        <marker
          id={ACTIVE_EDGE_DOT_MARKER}
          markerWidth="13"
          markerHeight="13"
          markerUnits="userSpaceOnUse"
          orient="auto"
          refX="0"
          refY="0"
          viewBox="-9 -6.5 13 13"
        >
          <circle cx="-4.5" cy="0" r="4" fill="var(--color-accent)" />
        </marker>
      </defs>
    </svg>
  );
}

/**
 * 让视口跟上布局变化，但尽量少动镜头。
 *
 * 分两档处理，因为这两件事用户的预期完全不同：
 * - 顶层节点集合变了（首屏、切焦点、换作用域）：整张图都不一样了，
 *   直接居中适配。
 * - 只是展开了某个节点：用户的注意力钉在那个节点上，把镜头拉走会
 *   丢掉他刚建立的空间记忆。所以只在新内容确实跑到视口外时才动，
 *   而且优先平移、能不缩放就不缩放。
 *
 * 包围盒自己算而不用 fitView：fitView 要等 React Flow 量完每个节点，
 * 那个时机比布局落地晚且不可靠，而 ELK 返回的坐标本来就是权威值。
 */
function useAutoViewport(nodes: PositionedNode[], version: number, attention: string | null) {
  const { setViewport, getViewport } = useReactFlow();
  const paneWidth = useFlowStore((s) => s.width);
  const paneHeight = useFlowStore((s) => s.height);
  const lastFittedKey = useRef<string | null>(null);

  const roots = useMemo(() => nodes.filter((n) => n.parentId === null), [nodes]);
  const rootKey = useMemo(() => roots.map((n) => n.dto.id).join("|"), [roots]);

  useEffect(() => {
    if (version === 0 || roots.length === 0) return;
    if (paneWidth === 0 || paneHeight === 0) return;

    const pane = { width: paneWidth, height: paneHeight };
    // 顶层节点的尺寸已经包含了它们展开的子树，所以只看顶层就是全图包围盒
    const whole = unionBox(roots.map((n) => ({ ...n, x: n.x, y: n.y })));

    if (rootKey !== lastFittedKey.current) {
      lastFittedKey.current = rootKey;
      const anchor = attention !== null ? absoluteBox(nodes, attention) : null;
      void setViewport(clampToContent(frameGraph(whole, anchor, pane), whole, pane), {
        duration: FIT_DURATION,
      });
      return;
    }

    // 整图还能在可读缩放内装下的话就装下它。展开一两层时常常属于这种情况，
    // 而这时去追刚展开的节点会把它上方那排兄弟顶到屏幕外——它们藏在顶栏
    // 底下既看不见也点不到，人就退不回兄弟层了。能都看见时就都给他看见。
    if (fitsReadably(whole, pane)) {
      void setViewport(clampToContent(centerOn(whole, pane), whole, pane), {
        duration: FIT_DURATION,
      });
      return;
    }

    // 装不下了才跟着注意力走。下钻三四层后全图早就大到没法在一屏里读，
    // 硬要装下只会把所有文字缩成噪点——这时用户真正想看的只是刚打开的那块。
    const target = (attention !== null ? absoluteBox(nodes, attention) : null) ?? whole;
    const next = nudgeIntoView(target, pane, getViewport());
    if (next) void setViewport(clampToContent(next, whole, pane), { duration: FIT_DURATION });
    // roots 每次布局都是新数组引用，真正的触发条件是 rootKey + version
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootKey, version, attention, paneWidth, paneHeight, setViewport, getViewport]);
}

function unionBox(boxes: ReadonlyArray<{ x: number; y: number; width: number; height: number }>): Box {
  const minX = Math.min(...boxes.map((b) => b.x));
  const minY = Math.min(...boxes.map((b) => b.y));
  return {
    x: minX,
    y: minY,
    width: Math.max(1, Math.max(...boxes.map((b) => b.x + b.width)) - minX),
    height: Math.max(1, Math.max(...boxes.map((b) => b.y + b.height)) - minY),
  };
}

/** ELK 给的坐标是相对父节点的，要一路加到根才是画布坐标 */
function absoluteBox(nodes: PositionedNode[], id: string): Box | null {
  const byId = new Map(nodes.map((n) => [n.dto.id, n]));
  const node = byId.get(id);
  if (!node) return null;

  let x = node.x;
  let y = node.y;
  for (let cursor = node.parentId; cursor !== null; ) {
    const parent = byId.get(cursor);
    if (!parent) break;
    x += parent.x;
    y += parent.y;
    cursor = parent.parentId;
  }
  return { x, y, width: node.width, height: node.height };
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 把 box 放进视口：装得下就居中，装不下就对齐到左上角。
 *
 * 溢出时居中意味着用户看到的是内容的中段，两头都被截掉；对齐左上角
 * 至少能从头开始读，也和分层布局「上游在上」的方向一致。
 */
/**
 * 换了一张图时怎么摆镜头。
 *
 * 能在可读缩放内装下就整图适配；装不下就以锚点居中。缩到 0.5 以下文字
 * 已经是噪点，"看到全部"这时候不是个有价值的目标——而把装不下的图
 * 左上对齐，会让用户刚点开的那个节点直接落在屏幕外。
 */
function frameGraph(
  whole: Box,
  anchor: Box | null,
  pane: { width: number; height: number },
): Viewport {
  const usable = 1 - FIT_PADDING * 2;
  const fitZoom = Math.min(
    (pane.width * usable) / whole.width,
    (pane.height * usable) / whole.height,
  );
  if (fitZoom >= FIT_MIN_ZOOM || anchor === null) return centerOn(whole, pane);

  return {
    zoom: FIT_MIN_ZOOM,
    x: pane.width / 2 - (anchor.x + anchor.width / 2) * FIT_MIN_ZOOM,
    y: pane.height / 2 - (anchor.y + anchor.height / 2) * FIT_MIN_ZOOM,
  };
}

/** 整图能否在文字还读得清的缩放下装进视口 */
function fitsReadably(whole: Box, pane: { width: number; height: number }): boolean {
  const usable = 1 - FIT_PADDING * 2;
  const fitZoom = Math.min(
    (pane.width * usable) / whole.width,
    (pane.height * usable) / whole.height,
  );
  return fitZoom >= FIT_MIN_ZOOM;
}

function centerOn(box: Box, pane: { width: number; height: number }): Viewport {
  const usable = 1 - FIT_PADDING * 2;
  const zoom = clamp(
    Math.min((pane.width * usable) / box.width, (pane.height * usable) / box.height),
    FIT_MIN_ZOOM,
    FIT_MAX_ZOOM,
  );
  const margin = Math.min(pane.width, pane.height) * FIT_PADDING;
  const overflowsX = box.width * zoom > pane.width - margin * 2;
  const overflowsY = box.height * zoom > pane.height - margin * 2;

  return {
    zoom,
    x: overflowsX ? margin - box.x * zoom : pane.width / 2 - (box.x + box.width / 2) * zoom,
    y: overflowsY ? margin - box.y * zoom : pane.height / 2 - (box.y + box.height / 2) * zoom,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把视口夹回内容边界内，不让画布滚过头。
 *
 * 展开一个节点时镜头会跟着它走，而 ELK 可能把它排在下方——追过去就会把
 * 上面那排兄弟节点顶到画布可视区之外。它们在顶栏底下既看不见也点不到，
 * 而渐进下钻恰恰要求人随时能退回兄弟层，所以这一步是必须的。
 *
 * 规则就是任何可平移画布的常规行为：内容装得下时整块留在视野内，装不下
 * 时允许滚动但不许滚出任何一端。
 */
function clampToContent(
  viewport: Viewport,
  whole: Box,
  pane: { width: number; height: number },
): Viewport {
  const { zoom } = viewport;
  const margin = Math.min(pane.width, pane.height) * FIT_PADDING;

  // 分别对应「内容左/上边缘贴到边距」和「右/下边缘贴到边距」两个极限位置。
  // 内容装得下时前者是下界，装不下时是上界，取 min/max 两种情况都成立。
  const xAtStart = margin - whole.x * zoom;
  const xAtEnd = pane.width - margin - (whole.x + whole.width) * zoom;
  const yAtStart = margin - whole.y * zoom;
  const yAtEnd = pane.height - margin - (whole.y + whole.height) * zoom;

  return {
    zoom,
    x: clamp(viewport.x, Math.min(xAtStart, xAtEnd), Math.max(xAtStart, xAtEnd)),
    y: clamp(viewport.y, Math.min(yAtStart, yAtEnd), Math.max(yAtStart, yAtEnd)),
  };
}

/**
 * 返回让 box 重新进入视野所需的最小视口变化，已经看得见就返回 null。
 *
 * 装不下时才退回居中适配；装得下就只平移，这样展开一个节点通常只是
 * 画面轻轻挪一下，用户还认得出原来的位置。
 */
function nudgeIntoView(
  box: Box,
  pane: { width: number; height: number },
  current: Viewport,
): Viewport | null {
  const margin = Math.min(pane.width, pane.height) * FIT_PADDING;
  const scaled = { width: box.width * current.zoom, height: box.height * current.zoom };

  if (scaled.width > pane.width - margin * 2 || scaled.height > pane.height - margin * 2) {
    return centerOn(box, pane);
  }

  const left = current.x + box.x * current.zoom;
  const top = current.y + box.y * current.zoom;
  const right = left + scaled.width;
  const bottom = top + scaled.height;

  let dx = 0;
  let dy = 0;
  if (left < margin) dx = margin - left;
  else if (right > pane.width - margin) dx = pane.width - margin - right;
  if (top < margin) dy = margin - top;
  else if (bottom > pane.height - margin) dy = pane.height - margin - bottom;

  // 一两个像素的偏差不值得触发一次动画
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return null;
  return { zoom: current.zoom, x: current.x + dx, y: current.y + dy };
}

interface RenderContext {
  metric: MetricKey;
  selected: string | null;
  hovered: string | null;
  highlight: { neighbors: Set<string>; edges: Set<string> } | null;
  lowDetail: boolean;
  labels: Map<string, string>;
  /** 布局方向为 RIGHT，连接点要挂在左右两侧 */
  horizontal: boolean;
  truncatedByScope: Record<string, number>;
}

function toFlowNode(node: PositionedNode, ctx: RenderContext): ScopeNodeType {
  const active = ctx.hovered === node.dto.id;
  const related = ctx.highlight?.neighbors.has(node.dto.id) ?? false;
  // 容器不参与衰减：把父容器调暗会让里面被高亮的子节点看起来很脏
  const dimmed = ctx.highlight !== null && !active && !related && !node.isContainer;

  return {
    id: node.dto.id,
    type: "scope",
    position: { x: node.x, y: node.y },
    parentId: node.parentId ?? undefined,
    extent: node.parentId !== null ? "parent" : undefined,
    draggable: true,
    // 尺寸必须走顶层 width/height，不能只写在 style 里。React Flow 会把
    // 尚未量到尺寸的节点标成 visibility:hidden，而 hidden 的元素不参与
    // 命中测试——每次重建 nodes 数组都会让节点短暂失去响应，双击于是
    // 随机失效。ELK 的尺寸本来就是权威值，直接告诉它，连测量都省了。
    width: node.width,
    height: node.height,
    zIndex: node.isContainer ? 0 : node.depth + 1,
    data: {
      dto: node.dto,
      label: ctx.labels.get(node.dto.id) ?? node.dto.label,
      metric: ctx.metric,
      isContainer: node.isContainer,
      selected: ctx.selected === node.dto.id,
      active,
      related,
      dimmed,
      lowDetail: ctx.lowDetail,
      horizontal: ctx.horizontal,
      truncatedInside: node.isContainer ? (ctx.truncatedByScope[node.dto.id] ?? 0) : 0,
    },
  };
}

export { nodeAccent };
