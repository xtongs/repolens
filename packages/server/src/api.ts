import {
  getCallGraph,
  getEntryPoints,
  getFileDetail,
  getFindingSummary,
  getRevealChain,
  getFindings,
  getMeta,
  getOverview,
  getScopeGraph,
  getSource,
  getSymbolDetail,
  getTree,
  getTrace,
  getTraceSummaries,
  generateFileSummary,
  generateSymbolSemantics,
  generateTraceNarrative,
  indexPath,
  openDb,
  search,
  type Confidence,
  type Db,
  type FileRole,
} from "@repolens/core";
import { Hono } from "hono";

export interface ApiDeps {
  db: Db;
  repoRoot: string;
}

/**
 * HTTP API。除带本地意图标记的 semantic POST 外均为只读。
 *
 * 所有端点都是「按需拉一层」的形状，没有任何返回全图的端点——
 * 这是 docs/INTERACTION.md「转移」策略的硬约束：前端不持有全图。
 */
export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();
  const { db } = deps;
  const repoRoot = getMeta(db, "repo_root") ?? deps.repoRoot;

  app.get("/overview", (c) => c.json(getOverview(db)));

  app.get("/tree", (c) => {
    const path = c.req.query("path") ?? ".";
    const depth = clampInt(c.req.query("depth"), 1, 0, 4);
    const roles = parseRoles(c.req.query("roles"));
    return c.json(getTree(db, path, depth, roles));
  });

  app.get("/graph", (c) => {
    const graph = getScopeGraph(db, {
      scope: c.req.query("scope") ?? undefined,
      limit: clampInt(c.req.query("limit"), 30, 3, 400),
      roles: parseRoles(c.req.query("roles")),
      confidence: parseConfidence(c.req.query("confidence")),
      includeExternal: parseBool(c.req.query("external")),
      keep: c.req.query("keep") ?? undefined,
    });
    return c.json(graph);
  });

  // 调用图和 /graph 分开：/graph 是「这个作用域里有什么」，按层级下钻；
  // 这里是「这个函数和谁有来往」，按跳数扩散。两者的分页语义完全不同，
  // 硬塞进一个端点只会让 limit 的含义变得含糊。
  app.get("/findings", (c) => {
    const kind = c.req.query("kind");
    return c.json({
      summary: getFindingSummary(db),
      items: getFindings(db, {
        kind: kind === "duplicate" || kind === "cycle" ? kind : undefined,
        scope: c.req.query("scope"),
        limit: clampInt(c.req.query("limit"), 200, 1, 1000),
      }),
    });
  });

  app.get("/reveal/:nodeId{.+}", (c) =>
    c.json({ chain: getRevealChain(db, c.req.param("nodeId")) }),
  );

  app.get("/callgraph/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    return c.json(
      getCallGraph(db, {
        symbolId: id,
        depth: clampInt(c.req.query("depth"), 1, 1, 4),
        direction: parseDirection(c.req.query("direction")),
        limit: clampInt(c.req.query("limit"), 12, 1, 200),
        confidence: parseConfidence(c.req.query("confidence")),
      }),
    );
  });

  app.get("/entries", (c) => c.json(getEntryPoints(db)));

  app.get("/traces", (c) => {
    const raw = c.req.query("entry");
    const entryId = raw === undefined ? undefined : numericId(raw);
    if (raw !== undefined && entryId === null) return c.json({ error: "非法的入口 id" }, 400);
    return c.json(getTraceSummaries(db, entryId ?? undefined));
  });

  app.get("/trace/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的链路 id" }, 400);
    const trace = getTrace(db, id);
    return trace ? c.json(trace) : c.json({ error: "链路不存在" }, 404);
  });

  app.get("/file/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    const detail = getFileDetail(db, id);
    return detail ? c.json(detail) : c.json({ error: "文件不存在" }, 404);
  });

  app.get("/symbol/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    const detail = getSymbolDetail(db, id);
    return detail ? c.json(detail) : c.json({ error: "符号不存在" }, 404);
  });

  // 语义生成是唯一写接口，但目标只能是当前索引里已有的数值 id，不能传路径。
  // 写连接按请求短暂打开，读连接仍保持 readonly，安全边界不被扩大。
  app.post("/semantic/symbol/:id", async (c) => {
    if (c.req.header("x-repolens-intent") !== "generate-semantic") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    if (getSymbolDetail(db, id) === null) return c.json({ error: "符号不存在" }, 404);
    return withWritableDb(repoRoot, async (writeDb) => {
      try {
        return c.json(await generateSymbolSemantics(writeDb, repoRoot, id));
      } catch (err) {
        const message = (err as Error).message;
        const status = /未设置环境变量|LLM 已.*关闭/.test(message) ? 503 : 502;
        return c.json({ error: message }, status);
      }
    });
  });

  app.post("/semantic/file/:id", async (c) => {
    if (c.req.header("x-repolens-intent") !== "generate-semantic") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    if (getFileDetail(db, id) === null) return c.json({ error: "文件不存在" }, 404);
    return withWritableDb(repoRoot, async (writeDb) => {
      try {
        return c.json(await generateFileSummary(writeDb, repoRoot, id));
      } catch (err) {
        const message = (err as Error).message;
        const status = /未设置环境变量|LLM 已.*关闭/.test(message) ? 503 : 502;
        return c.json({ error: message }, status);
      }
    });
  });

  app.post("/semantic/trace/:id", async (c) => {
    if (c.req.header("x-repolens-intent") !== "generate-semantic") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的链路 id" }, 400);
    if (getTrace(db, id) === null) return c.json({ error: "链路不存在" }, 404);
    return withWritableDb(repoRoot, async (writeDb) => {
      try { return c.json(await generateTraceNarrative(writeDb, repoRoot, id)); }
      catch (err) {
        const message = (err as Error).message;
        const status = /未设置环境变量|LLM 已.*关闭/.test(message) ? 503 : 502;
        return c.json({ error: message }, status);
      }
    });
  });

  app.get("/source/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    const from = optionalInt(c.req.query("from"));
    const to = optionalInt(c.req.query("to"));
    const slice = getSource(db, repoRoot, id, from, to);
    return slice ? c.json(slice) : c.json({ error: "源码不可读" }, 404);
  });

  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json(
      search(db, q, clampInt(c.req.query("limit"), 30, 1, 100), parseRoles(c.req.query("roles"))),
    );
  });

  return app;
}

async function withWritableDb<T>(repoRoot: string, run: (db: Db) => Promise<T>): Promise<T> {
  const writeDb = openDb(indexPath(repoRoot));
  try {
    return await run(writeDb);
  } finally {
    writeDb.close();
  }
}

// ---------------------------------------------------------------------------

const ALL_ROLES: FileRole[] = [
  "source",
  "test",
  "config",
  "generated",
  "types",
  "docs",
  "asset",
  "vendor",
];

const ALL_CONFIDENCE: Confidence[] = ["exact", "likely", "ambiguous", "external", "unresolved"];

function parseRoles(raw: string | undefined): FileRole[] | undefined {
  if (!raw) return undefined;
  const parsed = raw.split(",").filter((r): r is FileRole => (ALL_ROLES as string[]).includes(r));
  return parsed.length > 0 ? parsed : undefined;
}

function parseConfidence(raw: string | undefined): Confidence[] | undefined {
  if (!raw) return undefined;
  const parsed = raw
    .split(",")
    .filter((c): c is Confidence => (ALL_CONFIDENCE as string[]).includes(c));
  return parsed.length > 0 ? parsed : undefined;
}

function parseDirection(raw: string | undefined): "callers" | "callees" | "both" {
  return raw === "callers" || raw === "callees" ? raw : "both";
}

/**
 * 布尔查询参数一律宽松解析。
 *
 * URLSearchParams 会把 true 写成 "true"，手写 curl 又习惯 "1"，只认其中
 * 一种就会得到一个永远关闭且不报错的开关——这个坑已经踩过一次。
 */
function parseBool(raw: string | undefined): boolean {
  return raw === "1" || raw === "true" || raw === "yes";
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function optionalInt(raw: string | undefined): number | undefined {
  const parsed = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** 节点 id 形如 `file:42`，前端可能直接把整个 id 传回来 */
function numericId(raw: string): number | null {
  const stripped = raw.includes(":") ? (raw.split(":").at(-1) ?? raw) : raw;
  const parsed = Number.parseInt(stripped, 10);
  return Number.isNaN(parsed) ? null : parsed;
}
