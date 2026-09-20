import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FlatGraph, FlatNode } from "../model";
import { LayoutEngine } from "./engine";

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 58;
/** 容器顶部要留出标题栏的高度 */
export const CONTAINER_HEADER = 34;
const HORIZONTAL_GAP = 28;
const ROOT_PADDING = 16;
const CONTAINER_SIDE_PADDING = 16;
const CONTAINER_BOTTOM_PADDING = 16;
/**
 * ELK 会因为节点高度不同产生几像素的 y 误差。小于这个值仍视为同一层，
 * 否则一排节点会被错误拆成几排。真正相邻层之间至少留了 44px，边界足够安全。
 */
const LAYER_CENTER_TOLERANCE = 24;

export interface PositionedNode extends FlatNode {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutResult {
  nodes: PositionedNode[];
  /** 布局是否还在计算中，用于显示骨架而不是空白 */
  pending: boolean;
  /** 每次有新坐标落地时自增，调用方用它判断"该重新适配视口了" */
  version: number;
}

/**
 * 结构图向下、调用图向右。
 *
 * 不是审美偏好：结构图的层级少而每层宽（一个目录几十个文件），向下排
 * 才能让每一层横向铺开；调用图正相反，层数由跳数决定而每层是一列邻居，
 * 向右排正好把「调用方 → 它 → 被调」摆成一条从左到右的流向，也把
 * 十几个邻居竖着放进屏幕高度里，而不是横着挤出画布。
 */
const LAYOUT_OPTIONS: Record<string, string> = {
  "elk.algorithm": "layered",
  "elk.direction": "DOWN",
  // 跨层级的边由 ELK 自己处理，这样所有边都可以挂在根上，
  // 前端不必计算最近公共祖先
  "elk.hierarchyHandling": "INCLUDE_CHILDREN",
  "elk.layered.spacing.nodeNodeBetweenLayers": "64",
  "elk.spacing.nodeNode": "28",
  "elk.spacing.edgeNode": "24",
  "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
  "elk.layered.cycleBreaking.strategy": "GREEDY_MODEL_ORDER",
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  "elk.layered.nodePlacement.favorStraightEdges": "true",
  "elk.layered.crossingMinimization.semiInteractive": "true",
  "elk.padding": `[top=${CONTAINER_HEADER + 12},left=16,bottom=16,right=16]`,
};

/**
 * 把扁平图交给 Worker 布局，返回带绝对/相对坐标的节点。
 *
 * 布局请求带自增 id，只接受最新一次的结果：用户快速连点展开时会产生
 * 多个并发请求，晚到的旧结果会让画面跳回上一个状态。
 */
export function useElkLayout(
  graph: FlatGraph,
  sizeOf: (node: FlatNode) => { width: number; height: number },
  direction: "DOWN" | "RIGHT" = "DOWN",
): LayoutResult {
  const engineRef = useRef<LayoutEngine | null>(null);
  const requestId = useRef(0);
  const [result, setResult] = useState<{
    positions: Map<string, { x: number; y: number; width: number; height: number }>;
    version: number;
  }>({ positions: new Map(), version: 0 });
  const [pending, setPending] = useState(false);
  const { positions, version } = result;

  useEffect(() => {
    const engine = new LayoutEngine();
    engineRef.current = engine;
    return () => {
      engine.dispose();
      engineRef.current = null;
    };
  }, []);

  const signature = useMemo(
    () =>
      JSON.stringify([
        direction,
        graph.nodes.map((n) => [n.dto.id, n.parentId, n.isContainer, sizeOf(n).width, sizeOf(n).height]),
        graph.edges.map((e) => [e.source, e.target]),
      ]),
    // sizeOf 每次渲染都是新函数引用，但它的输出已经被序列化进签名里
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph, direction],
  );

  useEffect(() => {
    const engine = engineRef.current;
    if (!engine || graph.nodes.length === 0) {
      // version 只在真实坐标落地时自增：调用方靠它判断"现在读到的坐标可信"，
      // 清空也算一次的话，首屏适配就会量到一堆还在原点的节点
      setResult((prev) => (prev.positions.size === 0 ? prev : { positions: new Map(), version: prev.version }));
      return;
    }

    // 用户快速连点展开会产生多个并发请求，只接受最后一次的结果，
    // 否则晚到的旧布局会把画面拽回上一个状态
    const id = ++requestId.current;
    setPending(true);

    void engine
      .layout(buildElkGraph(graph, sizeOf, direction))
      .then((laid) => {
        if (id !== requestId.current) return;
        // ELK 很擅长决定依赖层级，却会为了少几处交叉而自由挪动每层的横坐标。
        // 结构图保留它算出的层级，再把同层节点放回稳定列网格：这样上下游仍然
        // 正确，同时相同行数的层会严格纵向对齐，展开前后位置也更容易预测。
        if (direction === "DOWN") alignDownwardGrid(laid);
        setResult((prev) => ({ positions: collectPositions(laid), version: prev.version + 1 }));
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setResult((prev) => ({ positions: new Map(), version: prev.version }));
      })
      .finally(() => {
        if (id === requestId.current) setPending(false);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const nodes = useMemo<PositionedNode[]>(
    () =>
      graph.nodes.map((node) => {
        const pos = positions.get(node.dto.id);
        const fallback = sizeOf(node);
        return {
          ...node,
          x: pos?.x ?? 0,
          y: pos?.y ?? 0,
          width: pos?.width ?? fallback.width,
          height: pos?.height ?? fallback.height,
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [graph.nodes, positions],
  );

  return { nodes, pending: pending && positions.size === 0, version };
}

function buildElkGraph(
  graph: FlatGraph,
  sizeOf: (node: FlatNode) => { width: number; height: number },
  direction: "DOWN" | "RIGHT",
): ElkNode {
  const byParent = new Map<string | null, FlatNode[]>();
  for (const node of graph.nodes) {
    const bucket = byParent.get(node.parentId) ?? [];
    bucket.push(node);
    byParent.set(node.parentId, bucket);
  }

  const build = (parentId: string | null): ElkNode[] =>
    (byParent.get(parentId) ?? []).map((node) => {
      const children = build(node.dto.id);
      const size = sizeOf(node);
      if (children.length === 0) {
        return { id: node.dto.id, width: size.width, height: size.height };
      }
      return {
        id: node.dto.id,
        children,
        layoutOptions: {
          "elk.padding": LAYOUT_OPTIONS["elk.padding"] as string,
          "elk.spacing.nodeNode": "20",
          "elk.layered.spacing.nodeNodeBetweenLayers": "44",
        },
      };
    });

  const edges: ElkExtendedEdge[] = [...graph.edges]
    .sort((a, b) =>
      a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id),
    )
    .map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    }));

  return {
    id: "root",
    layoutOptions: {
      ...LAYOUT_OPTIONS,
      "elk.direction": direction,
      // 左右顺序由服务端稳定提供：包/目录/文件按路径，符号按源码行。
      // 不允许为了少一条交叉线把节点换位，否则同一张图刷新后很难找回目标。
      "elk.layered.crossingMinimization.forceNodeModelOrder": "true",
    },
    children: build(null),
    edges,
  };
}

interface GridLayer {
  originalCenter: number;
  nodes: ElkNode[];
}

/**
 * 把 ELK 的纵向分层结果整理成可读的列网格。
 *
 * - y 层级完全沿用 ELK，因此依赖方向和环路拆分不变；
 * - 同层节点按输入模型顺序排列，而不是被交叉优化随机换位；
 * - 每层围绕同一条中轴线、使用同一列间距，稀疏层也能和相邻层对齐；
 * - 容器递归处理并按新内容重新计算尺寸，避免展开后子节点溢出边框。
 */
function alignDownwardGrid(parent: ElkNode, root = true): void {
  const children = parent.children;
  if (!children || children.length === 0) return;

  // 必须在递归改写子容器尺寸之前记录 ELK 的层。容器变高后再按中心点分组，
  // 原本同层的容器和普通节点就可能被误判成两个层级。
  const order = new Map(children.map((node, index) => [node.id, index]));
  const layers = groupIntoLayers(children);
  for (const child of children) alignDownwardGrid(child, false);

  const ordinaryWidths = children
    .filter((node) => !node.children || node.children.length === 0)
    .map((node) => node.width ?? NODE_WIDTH);
  const columnWidth = Math.max(NODE_WIDTH, ...ordinaryWidths);
  const columnStep = columnWidth + HORIZONTAL_GAP;
  const maxColumns = Math.max(...layers.map((layer) => layer.nodes.length));
  const betweenLayers = root ? 64 : 44;
  const topPadding = root ? ROOT_PADDING : CONTAINER_HEADER + 12;
  const sidePadding = root ? ROOT_PADDING : CONTAINER_SIDE_PADDING;
  const bottomPadding = root ? ROOT_PADDING : CONTAINER_BOTTOM_PADDING;

  let y = topPadding;
  let minEdge = Number.POSITIVE_INFINITY;
  let maxEdge = Number.NEGATIVE_INFINITY;

  for (const layer of layers) {
    layer.nodes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    const rowHeight = Math.max(...layer.nodes.map((node) => node.height ?? NODE_HEIGHT));
    const count = layer.nodes.length;
    // 所有层共用 maxColumns 个固定列。少节点的层取中间一段列，而不是
    // 重新以自己的节点数居中；后者会让奇数行和偶数行永远错开半列。
    const firstColumn = Math.floor((maxColumns - count) / 2);
    let previousCenter = Number.NEGATIVE_INFINITY;
    let previousWidth = 0;

    for (let index = 0; index < count; index++) {
      const node = layer.nodes[index]!;
      const width = node.width ?? NODE_WIDTH;
      const height = node.height ?? NODE_HEIGHT;
      const desiredCenter = (firstColumn + index - (maxColumns - 1) / 2) * columnStep;
      // 展开的容器可能比一个标准列宽得多。正常节点严格落在列线上；只有
      // 宽容器会把同排后续节点向右推，确保它们不重叠。
      const minimumCenter = previousCenter + previousWidth / 2 + HORIZONTAL_GAP + width / 2;
      const center = Math.max(desiredCenter, minimumCenter);
      node.x = center - width / 2;
      node.y = y + (rowHeight - height) / 2;
      previousCenter = center;
      previousWidth = width;
    }
    minEdge = Math.min(minEdge, ...layer.nodes.map((node) => node.x ?? 0));
    maxEdge = Math.max(
      maxEdge,
      ...layer.nodes.map((node) => (node.x ?? 0) + (node.width ?? NODE_WIDTH)),
    );

    y += rowHeight + betweenLayers;
  }

  // 所有层先以 x=0 为共同中轴排布，再整体平移进父容器。保留 ELK 给出的
  // 更大尺寸可避免容器标题或端口被压缩，但内容始终在容器中间。
  const contentWidth = maxEdge - minEdge;
  const requiredWidth = contentWidth + sidePadding * 2;
  const width = Math.max(parent.width ?? 0, requiredWidth);
  const xShift = sidePadding - minEdge + (width - requiredWidth) / 2;
  for (const child of children) child.x = (child.x ?? 0) + xShift;

  parent.width = width;
  parent.height = Math.max(parent.height ?? 0, y - betweenLayers + bottomPadding);
}

/** 按 ELK 给出的纵向中心点恢复层级；同层保留原始模型顺序。 */
function groupIntoLayers(children: readonly ElkNode[]): GridLayer[] {
  const sorted = [...children].sort((a, b) => centerY(a) - centerY(b));
  const layers: GridLayer[] = [];
  for (const node of sorted) {
    const center = centerY(node);
    const last = layers.at(-1);
    if (!last || Math.abs(center - last.originalCenter) > LAYER_CENTER_TOLERANCE) {
      layers.push({ originalCenter: center, nodes: [node] });
      continue;
    }
    last.nodes.push(node);
    last.originalCenter =
      last.nodes.reduce((sum, item) => sum + centerY(item), 0) / last.nodes.length;
  }
  return layers;
}

function centerY(node: ElkNode): number {
  return (node.y ?? 0) + (node.height ?? NODE_HEIGHT) / 2;
}

/** ELK 返回的坐标已经是相对父节点的，与 React Flow 的 parentId 语义一致 */
function collectPositions(
  root: ElkNode,
): Map<string, { x: number; y: number; width: number; height: number }> {
  const out = new Map<string, { x: number; y: number; width: number; height: number }>();
  const visit = (node: ElkNode) => {
    for (const child of node.children ?? []) {
      out.set(child.id, {
        x: child.x ?? 0,
        y: child.y ?? 0,
        width: child.width ?? NODE_WIDTH,
        height: child.height ?? NODE_HEIGHT,
      });
      visit(child);
    }
  };
  visit(root);
  return out;
}
