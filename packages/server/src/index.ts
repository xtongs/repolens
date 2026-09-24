import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { forgetRepo, indexPath, isIndexCurrent } from "@repolens/core";
import { existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_HEADER, sameToken } from "./auth.js";
import { DirectoryPickerUnavailableError, pickDirectory } from "./directory-picker.js";
import { RepoPool, RepoUnavailableError } from "./repo-pool.js";
import { InvalidScanRootError, ScanBusyError, ScanManager } from "./scan-manager.js";

export { createApi, type ApiDeps } from "./api.js";
export { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_HEADER } from "./auth.js";
export { RepoPool, RepoUnavailableError } from "./repo-pool.js";

/**
 * 默认端口。
 *
 * 刻意避开 5173（Vite dev）、3000、8080 这些高频占用的端口，
 * 也避开 5000 / 7000（macOS 的 AirPlay 接收器默认占用）。
 */
export const DEFAULT_PORT = 7173;

export interface ServeOptions {
  /** 缺省请求落到的仓库。null 表示只按清单提供仓库，桌面端首次启动时清单可能是空的 */
  repoRoot: string | null;
  /** 传 0 由系统分配空闲端口，实际端口见返回值 */
  port: number;
  host?: string;
  /** 前端构建产物目录；缺省时自动定位 @repolens/web 的 dist */
  webRoot?: string;
  /** 替换内置的系统目录选择器，桌面端用它弹原生对话框 */
  pickDirectory?: () => Promise<string | null>;
  /**
   * 设置后，每个 /api 请求都必须通过 cookie 或请求头带上这个令牌。
   *
   * 127.0.0.1 对同机的所有程序、以及浏览器里打开的任意网页都是可达的；
   * 命令行用户自己在终端里起服务可以接受这一点，常驻后台的桌面应用不行。
   */
  accessToken?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export async function startServer(options: ServeOptions): Promise<RunningServer> {
  const repoRoot = options.repoRoot === null ? null : resolve(options.repoRoot);
  if (repoRoot !== null) {
    const dbPath = indexPath(repoRoot);
    if (!existsSync(dbPath)) {
      throw new Error(`索引不存在：${dbPath}\n先运行 \`repolens scan ${options.repoRoot}\``);
    }
    if (!isIndexCurrent(dbPath)) {
      throw new Error(`索引版本过期：${dbPath}\n运行 \`repolens scan ${options.repoRoot} --fresh\` 重建索引`);
    }
  }

  const pool = new RepoPool(repoRoot);
  const scans = new ScanManager();
  const pick = options.pickDirectory ?? pickDirectory;
  const app = new Hono();

  // Hono 默认把异常吞成一句 "Internal Server Error"。这是个本地工具，
  // 报错必须同时出现在终端和响应里，否则查问题只能靠猜。
  app.onError((err, c) => {
    console.error(`[repolens] ${c.req.method} ${c.req.path} 失败：`, err);
    return c.json({ error: err.message }, 500);
  });

  const accessToken = options.accessToken;
  if (accessToken !== undefined) {
    app.use("/api/*", async (c, next) => {
      const provided = c.req.header(ACCESS_TOKEN_HEADER) ?? getCookie(c, ACCESS_TOKEN_COOKIE);
      if (provided === undefined || !sameToken(provided, accessToken)) {
        return c.json({ error: "缺少访问令牌" }, 401);
      }
      await next();
    });
  }

  // 仓库清单本身不属于任何一个仓库，所以不走下面的按仓库分发。
  // 必须注册在分发之前，否则会被 /api/* 抢走然后在子应用里 404。
  app.get("/api/repos", (c) => c.json({ current: pool.currentId, repos: pool.list() }));

  // 路径不由浏览器提交：这个端点在服务进程里唤起系统目录选择器，并把
  // 选择结果直接交给扫描器，避免新增一个可读取任意绝对路径的 HTTP API。
  app.post("/api/repos/pick-and-scan", async (c) => {
    if (c.req.header("x-repolens-intent") !== "scan-repository") {
      return c.json({ error: "缺少仓库扫描确认标记" }, 403);
    }

    try {
      const selected = await pick();
      if (selected === null) return c.json({ cancelled: true });
      return c.json({ cancelled: false, task: scans.start(selected) });
    } catch (err) {
      if (err instanceof ScanBusyError) return c.json({ error: err.message }, 409);
      if (err instanceof InvalidScanRootError) return c.json({ error: err.message }, 400);
      if (err instanceof DirectoryPickerUnavailableError) return c.json({ error: err.message }, 501);
      throw err;
    }
  });

  app.get("/api/repo-scans", (c) => c.json({ tasks: scans.list() }));

  app.get("/api/repo-scans/:id", (c) => {
    const task = scans.get(c.req.param("id"));
    return task ? c.json(task) : c.json({ error: "扫描任务不存在或服务已经重启" }, 404);
  });

  app.post("/api/repos/:id/scan", (c) => {
    if (c.req.header("x-repolens-intent") !== "scan-repository") {
      return c.json({ error: "缺少仓库扫描确认标记" }, 403);
    }
    try {
      // 浏览器只提交清单中的短 id，不接受绝对路径，避免把重扫接口变成
      // 任意目录读取入口。已有索引也必须真正执行一次增量扫描。
      return c.json(scans.start(pool.root(c.req.param("id")), { scanExisting: true }));
    } catch (err) {
      if (err instanceof ScanBusyError) return c.json({ error: err.message }, 409);
      if (err instanceof InvalidScanRootError) return c.json({ error: err.message }, 400);
      if (err instanceof RepoUnavailableError) return c.json({ error: err.message }, err.status);
      throw err;
    }
  });

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
    const root = resolve(webRoot);
    app.use("/*", serveStatic({ root }));
    // SPA 兜底：非 /api 的未命中路径一律回 index.html
    app.get("*", serveStatic({ path: join(root, "index.html") }));
  } else {
    app.get("/", (c) =>
      c.text("前端尚未构建。运行 `pnpm --filter @repolens/web build` 后重启，或用 `pnpm dev:web` 起开发服务器。"),
    );
  }

  const host = options.host ?? "127.0.0.1";
  const { server, port } = await listen(app, options.port, host);

  return {
    url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}`,
    port,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => {
          void scans.close().finally(() => {
            pool.close();
            done();
          });
        });
        // close() 只停止接受新连接。浏览器的长连接、还在输出的追问流都会让它
        // 一直等下去，退出时直接断开。
        if ("closeAllConnections" in server) server.closeAllConnections();
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

function listen(app: Hono, port: number, hostname: string) {
  return new Promise<{ server: ReturnType<typeof serve>; port: number }>((done, fail) => {
    const server = serve({ fetch: app.fetch, port, hostname }, (info: AddressInfo) => {
      server.off("error", fail);
      done({ server, port: info.port });
    });
    server.once("error", fail);
  });
}
