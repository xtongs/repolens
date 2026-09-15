import type { GraphDto, GraphEdgeDto, GraphNodeDto } from "@repolens/core/types";

/**
 * 拼图所需的最小状态切片。
 *
 * 刻意不接收整个 store：画布重渲染一次要重建全部节点，而 hover
 * 这类高频状态跟图的结构无关，混进来就会让掠过图面变成连续重排。
 */
export interface GraphSlice {
  rootScope: string;
  subgraphs: Record<string, GraphDto>;
  expanded: string[];
  hiddenNodes: string[];
}

export interface FlatNode {
  dto: GraphNodeDto;
  parentId: string | null;
  depth: number;
  /** 该节点是否处于展开状态（即渲染为容器） */
  isContainer: boolean;
}

export interface FlatGraph {
  nodes: FlatNode[];
  edges: GraphEdgeDto[];
  /** 每个容器被折叠掉的数量，用于层叠卡片的角标 */
  truncatedByScope: Record<string, number>;
}

/**
 * 把「按作用域分片加载的子图」拼成一棵可渲染的嵌套结构。
 *
 * 这里是渐进式下钻的核心：展开状态只是一个 id 集合，真正的层级是
 * 在每次渲染时按已加载的子图重新推导出来的。这样展开/收起不需要
 * 维护任何增量的树结构，也就不会出现状态和数据不一致。
 */
export function flattenGraph(slice: GraphSlice): FlatGraph {
  const { rootScope, subgraphs, expanded, hiddenNodes } = slice;
  const expandedSet = new Set(expanded);
  const hidden = new Set(hiddenNodes);

  const nodes: FlatNode[] = [];
  const edges: GraphEdgeDto[] = [];
  const truncatedByScope: Record<string, number> = {};
  const seen = new Set<string>();

  const visit = (scopeId: string, parentId: string | null, depth: number): void => {
    const graph = subgraphs[scopeId];
    if (!graph) return;

    truncatedByScope[scopeId] = graph.truncated;

    for (const dto of graph.nodes) {
      if (hidden.has(dto.id) || seen.has(dto.id)) continue;
      seen.add(dto.id);

      const isContainer = expandedSet.has(dto.id) && subgraphs[dto.id] !== undefined;
      nodes.push({ dto, parentId, depth, isContainer });

      if (isContainer) visit(dto.id, dto.id, depth + 1);
    }

    for (const edge of graph.edges) {
      if (hidden.has(edge.source) || hidden.has(edge.target)) continue;
      edges.push(edge);
    }
  };

  visit(rootScope, null, 0);

  // 展开一个容器后，指向容器整体的边依然有意义（它代表「这一整块被依赖」），
  // 所以不做重定向，只去掉两端落在同一容器内部的自环。
  const present = new Set(nodes.map((n) => n.dto.id));
  const deduped = new Map<string, GraphEdgeDto>();
  for (const edge of edges) {
    if (!present.has(edge.source) || !present.has(edge.target)) continue;
    if (edge.source === edge.target) continue;
    const existing = deduped.get(edge.id);
    if (existing) {
      existing.count += edge.count;
      continue;
    }
    deduped.set(edge.id, { ...edge });
  }

  return { nodes, edges: [...deduped.values()], truncatedByScope };
}

/**
 * 聚焦模式：只保留与焦点节点在 depth 跳以内相连的节点。
 *
 * 无向扩展而不是只看出向边——用户问「谁和它有关系」时，
 * 调用方和被调用方同样重要。
 */
export function applyFocus(graph: FlatGraph, focus: string | null, depth: number): FlatGraph {
  if (focus === null) return graph;
  if (!graph.nodes.some((n) => n.dto.id === focus)) return graph;

  const adjacency = new Map<string, Set<string>>();
  const connect = (a: string, b: string) => {
    const bucket = adjacency.get(a) ?? new Set<string>();
    bucket.add(b);
    adjacency.set(a, bucket);
  };
  for (const edge of graph.edges) {
    connect(edge.source, edge.target);
    connect(edge.target, edge.source);
  }

  const keep = new Set<string>([focus]);
  let frontier = [focus];
  for (let hop = 0; hop < depth; hop++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const neighbor of adjacency.get(id) ?? []) {
        if (keep.has(neighbor)) continue;
        keep.add(neighbor);
        next.push(neighbor);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  // 祖先容器必须保留，否则子节点会失去 parentId 指向的父节点
  for (const node of graph.nodes) {
    if (!keep.has(node.dto.id)) continue;
    let cursor = node.parentId;
    while (cursor !== null) {
      keep.add(cursor);
      cursor = graph.nodes.find((n) => n.dto.id === cursor)?.parentId ?? null;
    }
  }

  return {
    nodes: graph.nodes.filter((n) => keep.has(n.dto.id)),
    edges: graph.edges.filter((e) => keep.has(e.source) && keep.has(e.target)),
    truncatedByScope: graph.truncatedByScope,
  };
}

/**
 * 在已加载的子图里直接找一个节点。
 *
 * hover 预览只需要一个节点，用 flattenGraph 去换它意味着每次鼠标
 * 移动都重建一遍整棵树。
 */
export function findNode(subgraphs: Record<string, GraphDto>, nodeId: string): GraphNodeDto | null {
  for (const graph of Object.values(subgraphs)) {
    const hit = graph.nodes.find((n) => n.id === nodeId);
    if (hit) return hit;
  }
  return null;
}

export function neighborIds(edges: readonly GraphEdgeDto[], nodeId: string): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    if (edge.source === nodeId) out.add(edge.target);
    else if (edge.target === nodeId) out.add(edge.source);
  }
  return out;
}

export function incidentEdgeIds(edges: readonly GraphEdgeDto[], nodeId: string): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    if (edge.source === nodeId || edge.target === nodeId) out.add(edge.id);
  }
  return out;
}
