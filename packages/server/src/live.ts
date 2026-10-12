import type { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { RepoUnavailableError, type RepoPool } from "./repo-pool.js";
import type { ScanManager } from "./scan-manager.js";
import { WatchManager, type WatchEvent } from "./watch-manager.js";

/** 代理和浏览器会掐掉太久没动静的连接 */
const HEARTBEAT_MS = 25_000;

/**
 * 索引的实时刷新：手动刷新、盯着文件变化，以及把「索引更新了」推给打开着的界面。
 * 路由必须挂在按仓库分发的 /api/* 之前。
 */
export class LiveUpdates {
  private readonly listeners = new Map<string, Set<(event: WatchEvent) => void>>();
  private readonly watches: WatchManager;

  constructor(private readonly scans: ScanManager) {
    this.watches = new WatchManager(scans, (repoId, event) => this.emit(repoId, event));
  }

  watch(repoId: string, root: string): void {
    this.watches.start(repoId, root);
  }

  close(): void {
    this.watches.close();
  }

  mount(app: Hono, pool: RepoPool): void {
    const rootOf = (id: string): string | Response => {
      try {
        return pool.root(id);
      } catch (err) {
        if (err instanceof RepoUnavailableError) return Response.json({ error: err.message }, { status: err.status });
        throw err;
      }
    };

    // 只刷新结构、不调用模型的增量扫描。「重新扫描并对比」等它跑完再取变更报告
    app.post("/api/repos/:id/refresh", async (c) => {
      if (c.req.header("x-repolens-intent") !== "scan-repository") {
        return c.json({ error: "缺少仓库扫描确认标记" }, 403);
      }
      const id = c.req.param("id");
      const root = rootOf(id);
      if (root instanceof Response) return root;
      await this.scans.refresh(root);
      const refreshedAt = new Date().toISOString();
      this.emit(id, { type: "index", refreshedAt });
      return c.json({ ok: true, refreshedAt });
    });

    app.get("/api/repos/:id/watch", (c) => c.json(this.watches.status(c.req.param("id"))));

    app.post("/api/repos/:id/watch", async (c) => {
      if (c.req.header("x-repolens-intent") !== "watch-repository") {
        return c.json({ error: "缺少本地写操作标记" }, 403);
      }
      const id = c.req.param("id");
      let enabled = false;
      try {
        enabled = ((await c.req.json()) as { enabled?: unknown }).enabled === true;
      } catch {
        return c.json({ error: "请求体不是 JSON" }, 400);
      }
      if (!enabled) return c.json(this.watches.stop(id));
      const root = rootOf(id);
      if (root instanceof Response) return root;
      return c.json(this.watches.start(id, root));
    });

    // 推给界面的事件：watch 状态变化，以及索引按最新文件刷新完了
    app.get("/api/repos/:id/events", (c) => {
      const id = c.req.param("id");
      return streamSSE(c, async (stream) => {
        const queue: WatchEvent[] = [{ type: "status", status: this.watches.status(id) }];
        let wake: (() => void) | null = null;
        const unsubscribe = this.subscribe(id, (event) => {
          queue.push(event);
          wake?.();
        });
        let open = true;
        stream.onAbort(() => {
          open = false;
          wake?.();
        });
        try {
          while (open) {
            while (queue.length > 0) {
              const event = queue.shift()!;
              await stream.writeSSE({ event: event.type, data: JSON.stringify(event) });
            }
            await new Promise<void>((done) => {
              wake = done;
              setTimeout(done, HEARTBEAT_MS);
            });
            wake = null;
            if (open && queue.length === 0) await stream.writeSSE({ event: "ping", data: "{}" });
          }
        } finally {
          unsubscribe();
        }
      });
    });
  }

  private emit(repoId: string, event: WatchEvent): void {
    for (const listener of this.listeners.get(repoId) ?? []) listener(event);
  }

  private subscribe(repoId: string, listener: (event: WatchEvent) => void): () => void {
    const set = this.listeners.get(repoId) ?? new Set();
    set.add(listener);
    this.listeners.set(repoId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(repoId);
    };
  }
}
