import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { indexPath, openDb, type Db } from "@repolens/core";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { Hono } from "hono";
import { createApi } from "./api.js";

export { createApi, type ApiDeps } from "./api.js";

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

  const db: Db = openDb(dbPath, { readonly: true });
  const app = new Hono();

  // Hono 默认把异常吞成一句 "Internal Server Error"。这是个本地工具，
  // 报错必须同时出现在终端和响应里，否则查问题只能靠猜。
  app.onError((err, c) => {
    console.error(`[repolens] ${c.req.method} ${c.req.path} 失败：`, err);
    return c.json({ error: err.message }, 500);
  });

  app.route("/api", createApi({ db, repoRoot }));

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
          db.close();
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
