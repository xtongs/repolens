import type { ElkExtendedEdge, ElkNode } from "elkjs/lib/elk-api";
import { useEffect, useMemo, useRef, useState } from "react";
import type { FlatGraph, FlatNode } from "../model";
import { LayoutEngine } from "./engine";

export const NODE_WIDTH = 188;
export const NODE_HEIGHT = 58;
/** 容器顶部要留出标题栏的高度 */
export const CONTAINER_HEADER = 34;

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
  "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
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

  const edges: ElkExtendedEdge[] = graph.edges.map((edge) => ({
    id: edge.id,
    sources: [edge.source],
    targets: [edge.target],
  }));

  return {
    id: "root",
    layoutOptions: { ...LAYOUT_OPTIONS, "elk.direction": direction },
    children: build(null),
    edges,
  };
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
