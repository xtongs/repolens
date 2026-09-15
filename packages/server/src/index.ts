import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { forgetRepo, indexPath } from "@repolens/core";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { Hono } from "hono";
import { RepoPool, RepoUnavailableError } from "./repo-pool.js";

export { createApi, type ApiDeps } from "./api.js";
export { RepoPool, RepoUnavailableError } from "./repo-pool.js";

/**
 * 默认端口。
 *
 * 刻意避开 5173（Vite dev）、3000、8080 这些高频占用的端口，
 * 也避开 5000 / 7000（macOS 的 AirPlay 接收器默认占用）。
 */
export const DEFAULT_PORT = 7173;

export interface ServeOptions {
  repoRoot: string;
  port: number;
  host?: string;
  /** 前端构建产物目录；缺省时自动定位 @repolens/web 的 dist */
  webRoot?: string;
}

export interface RunningServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const repoRoot = resolve(options.repoRoot);
  const dbPath = indexPath(repoRoot);

  if (!existsSync(dbPath)) {
    throw new Error(`索引不存在：${dbPath}\n先运行 \`repolens scan ${options.repoRoot}\``);
  }

  const pool = new RepoPool(repoRoot);
  const app = new Hono();

  // Hono 默认把异常吞成一句 "Internal Server Error"。这是个本地工具，
  // 报错必须同时出现在终端和响应里，否则查问题只能靠猜。
  app.onError((err, c) => {
    console.error(`[repolens] ${c.req.method} ${c.req.path} 失败：`, err);
    return c.json({ error: err.message }, 500);
  });

  // 仓库清单本身不属于任何一个仓库，所以不走下面的按仓库分发。
  // 必须注册在分发之前，否则会被 /api/* 抢走然后在子应用里 404。
  app.get("/api/repos", (c) => c.json({ current: pool.currentId, repos: pool.list() }));

  // 只从清单里移除，不动仓库和索引。仓库被删或移走后清单里会留下死条目，
  // 没有这个端点就只能手改 ~/.repolens/repos.json。
  app.delete("/api/repos/:id", (c) => {
    const id = c.req.param("id");
    if (id === pool.currentId) {
      return c.json({ error: "不能移除当前正在浏览的仓库" }, 400);
    }
    return forgetRepo(id) ? c.json({ removed: id }) : c.json({ error: "清单里没有这个仓库" }, 404);
  });

  // 按 `?repo=<id>` 分发到对应仓库的 API 子应用，缺省落到启动时那个仓库。
  // 用查询参数而不是路径前缀，是为了让缺省可用：前端首屏不必先取一次清单
  // 才敢发第一个请求，curl 也还能照原样敲。
  app.all("/api/*", (c) => {
    let entry;
    try {
      entry = pool.resolve(c.req.query("repo"));
    } catch (err) {
      if (err instanceof RepoUnavailableError) return c.json({ error: err.message }, err.status);
      throw err;
    }
    const url = new URL(c.req.url);
    url.pathname = url.pathname.slice("/api".length) || "/";
    return entry.api.fetch(new Request(url, c.req.raw));
  });

  const webRoot = options.webRoot ?? locateWebRoot();
  if (webRoot !== null) {
    // serveStatic 的 root 必须是相对 cwd 的路径
    const rel = toPosix(relative(process.cwd(), webRoot)) || ".";
    app.use("/*", serveStatic({ root: rel }));
    // SPA 兜底：非 /api 的未命中路径一律回 index.html
    app.get("*", serveStatic({ path: `${rel}/index.html` }));
  } else {
    app.get("/", (c) =>
      c.text("前端尚未构建。运行 `pnpm --filter @repolens/web build` 后重启，或用 `pnpm dev:web` 起开发服务器。"),
    );
  }

  const host = options.host ?? "127.0.0.1";
  const server = serve({ fetch: app.fetch, port: options.port, hostname: host });

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${options.port}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          pool.close();
          done();
        });
      }),
  };
}

function locateWebRoot(): string | null {
  const require = createRequire(import.meta.url);
  try {
    const pkgPath = require.resolve("@repolens/web/package.json");
    const dist = resolve(dirname(pkgPath), "dist");
    return existsSync(resolve(dist, "index.html")) ? dist : null;
  } catch {
    return null;
  }
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}
