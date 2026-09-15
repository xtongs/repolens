import type { ElkNode } from "elkjs/lib/elk-api";
import type { LayoutRequest, LayoutResponse } from "./elk.worker";

type ElkLike = { layout: (graph: ElkNode) => Promise<ElkNode> };

/**
 * 布局引擎。
 *
 * 首选 Worker（把 CPU 密集的布局挪出主线程），但 Worker 在某些打包/浏览器
 * 组合下会起不来。布局失败意味着整张图退化成一堆重叠在原点的方块——
 * 这个失败模式太严重，必须有主线程兜底。
 */
export class LayoutEngine {
  private worker: Worker | null = null;
  private workerBroken = false;
  private mainThreadElk: Promise<ElkLike> | null = null;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (graph: ElkNode) => void; reject: (err: Error) => void }
  >();

  async layout(graph: ElkNode): Promise<ElkNode> {
    if (!this.workerBroken) {
      try {
        return await this.layoutInWorker(graph);
      } catch {
        this.workerBroken = true;
        this.disposeWorker();
      }
    }
    const elk = await this.getMainThreadElk();
    return elk.layout(graph);
  }

  dispose(): void {
    this.disposeWorker();
    for (const entry of this.pending.values()) entry.reject(new Error("布局引擎已释放"));
    this.pending.clear();
  }

  private layoutInWorker(graph: ElkNode): Promise<ElkNode> {
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const request: LayoutRequest = { id, graph };

    return new Promise<ElkNode>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      worker.postMessage(request);
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const worker = new Worker(new URL("./elk.worker.ts", import.meta.url), { type: "module" });

    worker.onmessage = (event: MessageEvent<LayoutResponse>) => {
      const entry = this.pending.get(event.data.id);
      if (!entry) return;
      this.pending.delete(event.data.id);
      if (event.data.graph) entry.resolve(event.data.graph);
      else entry.reject(new Error(event.data.error ?? "布局失败"));
    };

    worker.onerror = () => {
      for (const entry of this.pending.values()) entry.reject(new Error("布局 Worker 崩溃"));
      this.pending.clear();
    };

    this.worker = worker;
    return worker;
  }

  private disposeWorker(): void {
    this.worker?.terminate();
    this.worker = null;
  }

  private getMainThreadElk(): Promise<ElkLike> {
    this.mainThreadElk ??= import("elkjs/lib/elk.bundled.js").then((mod) => {
      const Ctor = resolveElkConstructor(mod);
      return new Ctor() as ElkLike;
    });
    return this.mainThreadElk;
  }
}

/**
 * elkjs 是 browserify 打出来的 UMD 包，不同打包器给出的 ESM 互操作形状不一样：
 * 可能是函数本身，也可能是 `{ default: 函数 }`，甚至再套一层。逐层剥到能 new 为止。
 */
export function resolveElkConstructor(mod: unknown): new (options?: unknown) => unknown {
  let candidate: unknown = mod;
  for (let depth = 0; depth < 3; depth++) {
    if (typeof candidate === "function") {
      return candidate as new (options?: unknown) => unknown;
    }
    if (candidate && typeof candidate === "object" && "default" in candidate) {
      candidate = (candidate as { default: unknown }).default;
      continue;
    }
    break;
  }
  throw new Error("无法从 elkjs 模块中取到构造函数");
}
