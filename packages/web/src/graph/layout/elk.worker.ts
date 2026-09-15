/// <reference lib="webworker" />
import * as elkModule from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api";
import { resolveElkConstructor } from "./engine";

/**
 * 布局 Worker。
 *
 * ELK 的分层布局是 CPU 密集的，在主线程跑会让拖拽和缩放掉帧——
 * 这是 docs/INTERACTION.md「转移」策略里明确要求转移出去的计算。
 */
export interface LayoutRequest {
  id: number;
  graph: ElkNode;
}

export interface LayoutResponse {
  id: number;
  graph?: ElkNode;
  error?: string;
}

const Elk = resolveElkConstructor(elkModule);
const elk = new Elk() as { layout: (graph: ElkNode) => Promise<ElkNode> };

self.onmessage = async (event: MessageEvent<LayoutRequest>) => {
  const { id, graph } = event.data;
  try {
    const laid = await elk.layout(graph);
    const message: LayoutResponse = { id, graph: laid };
    self.postMessage(message);
  } catch (err) {
    const message: LayoutResponse = { id, error: (err as Error).message };
    self.postMessage(message);
  }
};
