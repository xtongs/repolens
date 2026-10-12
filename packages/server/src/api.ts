import {
  BaselineError,
  FINDING_KINDS,
  UnderstandingInputError,
  buildChangeReport,
  buildLock,
  confirmedLayers,
  currentLlmStatus,
  getBoundary,
  getCallGraph,
  getEntryPoints,
  getFileDetail,
  getFileTree,
  getFindingSummary,
  getLens,
  getModuleCard,
  getRevealChain,
  getFindings,
  getOverview,
  getScopeGraph,
  getScopeReadme,
  getSkeleton,
  getSource,
  getSpec,
  getSymbolDetail,
  getTree,
  getTypeFlow,
  getUnderstanding,
  getWalkFrame,
  generateFileSummary,
  generateSymbolSemantics,
  markUnderstood,
  NoteInputError,
  addNote,
  deleteNote,
  indexPath,
  listCommits,
  listNotes,
  loadConfig,
  openDb,
  parseChatRequest,
  parseNoteInput,
  readRepoFile,
  recordChatUsage,
  refreshConventions,
  RepoFileError,
  search,
  streamRepositoryChat,
  unmark,
  updateRepoConfig,
  writeLock,
  type Confidence,
  type ConfirmedLayer,
  type Db,
  type FileRole,
  type LensKind,
  type UnderstandingHow,
} from "@repolens/core";
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";

export interface ApiDeps {
  db: Db;
  repoRoot: string;
}

/**
 * HTTP API。除带本地意图标记的 semantic / chat / notes 写请求外均为只读。
 *
 * 所有端点都是「按需拉一层」的形状，没有任何返回全图的端点——
 * 这是 docs/INTERACTION.md「转移」策略的硬约束：前端不持有全图。
 */
export function createApi(deps: ApiDeps): Hono {
  const app = new Hono();
  const { db } = deps;
  // 以索引实际所在的目录为准，不用索引里记的 repo_root：仓库连同 .repolens
  // 一起被移动或复制后，那个路径指向的是旧位置，读源码、写缓存和笔记都会落错地方。
  const { repoRoot } = deps;

  app.get("/overview", (c) => {
    const overview = getOverview(db);
    return c.json({ ...overview, llm: currentLlmStatus(db, repoRoot) ?? overview.llm });
  });

  app.get("/tree", (c) => {
    const path = c.req.query("path") ?? ".";
    const depth = clampInt(c.req.query("depth"), 1, 0, 4);
    const roles = parseRoles(c.req.query("roles"));
    return c.json(getTree(db, path, depth, roles));
  });

  // 结构树按磁盘列全部文件，和只看索引的 /tree 分开：这里要读目录、按配置判定排除原因
  app.get("/files", (c) =>
    repoFile(c, () => getFileTree(db, repoRoot, loadConfig(repoRoot), c.req.query("path") ?? ".")),
  );

  app.get("/raw", (c) => repoFile(c, () => readRepoFile(repoRoot, c.req.query("path") ?? "")));

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
    const scope = c.req.query("scope");
    return c.json({
      summary: getFindingSummary(db, scope),
      items: getFindings(db, {
        kind: FINDING_KINDS.find((known) => known === kind),
        scope,
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

  // 单步走读一次只取一帧：步入时前端再按落点 id 取下一帧，调用栈由前端持有
  app.get("/walk/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    const frame = getWalkFrame(db, id);
    return frame ? c.json(frame) : c.json({ error: "符号不存在" }, 404);
  });

  app.get("/file/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    const detail = getFileDetail(db, id, repoRoot);
    return detail ? c.json(detail) : c.json({ error: "文件不存在" }, 404);
  });

  app.get("/symbol/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    const detail = getSymbolDetail(db, id, repoRoot);
    return detail ? c.json(detail) : c.json({ error: "符号不存在" }, 404);
  });

  // 架构图上一条边由什么构成：跨过边界的 import、被用到的符号、对上的路由；没有直接依赖时给最短链
  app.get("/boundary", (c) => {
    const boundary = getBoundary(db, c.req.query("from") ?? "", c.req.query("to") ?? "", parseRoles(c.req.query("roles")));
    return boundary ? c.json(boundary) : c.json({ error: "认不出这两个节点" }, 404);
  });

  app.get("/module", (c) => {
    const card = getModuleCard(db, c.req.query("node") ?? "");
    return card ? c.json(card) : c.json({ error: "只有包和目录有模块名片" }, 404);
  });

  app.get("/spec", (c) => {
    const spec = getSpec(db, c.req.query("node") ?? "");
    return spec ? c.json(spec) : c.json({ error: "节点不存在" }, 404);
  });

  app.get("/typeflow/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的符号 id" }, 400);
    const flow = getTypeFlow(db, id);
    return flow ? c.json(flow) : c.json({ error: "不是类型" }, 404);
  });

  app.get("/skeleton", (c) => c.json(getSkeleton(db)));

  app.get("/lens", (c) => {
    const kind = c.req.query("kind");
    if (kind !== "heat" && kind !== "tests" && kind !== "understanding") return c.json({ error: "未知的视角" }, 400);
    const ids = (c.req.query("ids") ?? "").split(",").filter((id) => /^(?:dir|pkg|file|sym):./.test(id));
    return c.json(getLens(db, repoRoot, kind as LensKind, ids));
  });

  // 理解账本写在索引旁边的 understanding.json，和笔记一样不经过 index.db
  app.get("/understanding", (c) => c.json(getUnderstanding(db, repoRoot)));

  app.post("/understanding", async (c) => {
    if (c.req.header("x-repolens-intent") !== "understanding") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const body = await jsonBody(c);
    const nodeId = typeof body?.["nodeId"] === "string" ? body["nodeId"] : null;
    const how = body?.["how"];
    if (nodeId === null) return c.json({ error: "缺少节点" }, 400);
    try {
      const mark = markUnderstood(db, repoRoot, nodeId, isHow(how) ? how : "manual");
      return c.json(mark);
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof UnderstandingInputError ? 400 : 500);
    }
  });

  app.delete("/understanding", (c) => {
    if (c.req.header("x-repolens-intent") !== "understanding") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    return unmark(repoRoot, c.req.query("key") ?? "") ? c.json({ ok: true }) : c.json({ error: "没有这条标记" }, 404);
  });

  // AI 提议的分层由人确认后写进约定，之后的分层倒置检查只认这一份
  app.post("/layers/confirm", async (c) => {
    if (c.req.header("x-repolens-intent") !== "confirm-layers") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const body = await jsonBody(c);
    const layers = parseLayers(body?.["layers"]);
    if (layers === null) return c.json({ error: "分层格式不正确：每层要有名字和至少一个 pkg: / dir: 成员" }, 400);
    updateRepoConfig(repoRoot, { layers });
    await withWritableDb(repoRoot, async (writeDb) => refreshConventions(writeDb, { layers }));
    return c.json({ layers: confirmedLayers(db) });
  });

  // 把当前的模块间依赖记成依赖锁：以后新长出来的依赖都要先经过批准
  app.post("/lock", async (c) => {
    if (c.req.header("x-repolens-intent") !== "write-lock") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    const lock = buildLock(db);
    writeLock(repoRoot, lock);
    await withWritableDb(repoRoot, async (writeDb) => refreshConventions(writeDb, { lock }));
    return c.json({ level: lock.level, dependencies: lock.dependencies.length });
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
        return c.json(await generateSymbolSemantics(writeDb, repoRoot, id, {
          force: parseBool(c.req.query("refresh")),
        }));
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
        return c.json(await generateFileSummary(writeDb, repoRoot, id, {
          force: parseBool(c.req.query("refresh")),
        }));
      } catch (err) {
        const message = (err as Error).message;
        const status = /未设置环境变量|LLM 已.*关闭/.test(message) ? 503 : 502;
        return c.json({ error: message }, status);
      }
    });
  });

  // 追问 AI。请求里只有问题文本和节点 id，源码由服务端按 id 现读；回答
  // 以 SSE 流回，事件依次是 context（实际放进提示词的上下文）、穿插出现的
  // delta 和 tool（模型自己去查的每一步），最后 done 或 error。读上下文用只读
  // 连接，写连接只在记账时短暂打开。
  app.post("/chat", async (c) => {
    if (c.req.header("x-repolens-intent") !== "chat") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是 JSON" }, 400);
    }
    const request = parseChatRequest(body);
    if (request === null) return c.json({ error: "对话格式不正确，最后一条必须是用户消息" }, 400);

    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      // delta 按到达顺序串行写出，避免并发 write 打乱顺序
      let writes = Promise.resolve();
      const send = (event: string, data: unknown) => {
        writes = writes.then(() => stream.writeSSE({ event, data: JSON.stringify(data) }));
        return writes;
      };
      try {
        const done = await streamRepositoryChat(db, repoRoot, request, {
          signal: controller.signal,
          onContext: (items) => void send("context", { items }),
          onDelta: (text) => void send("delta", { text }),
          onTool: (step) => void send("tool", step),
        });
        await send("done", done);
        await withWritableDb(repoRoot, async (writeDb) => recordChatUsage(writeDb, repoRoot, done.usage));
      } catch (err) {
        if (controller.signal.aborted) return;
        await send("error", { message: (err as Error).message.slice(0, 500) });
      }
    });
  });

  // 笔记写在索引旁边的 notes.json 里，不经过 index.db，所以只读连接就够用：
  // 它只负责把节点 id 换算成路径和行号。
  app.get("/notes", (c) => {
    try {
      return c.json({ notes: listNotes(db, repoRoot) });
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  app.post("/notes", async (c) => {
    if (c.req.header("x-repolens-intent") !== "save-note") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "请求体不是 JSON" }, 400);
    }
    const input = parseNoteInput(body);
    if (input === null) return c.json({ error: "笔记格式不正确" }, 400);
    try {
      return c.json(addNote(db, repoRoot, input));
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof NoteInputError ? 400 : 500);
    }
  });

  app.delete("/notes/:id", (c) => {
    if (c.req.header("x-repolens-intent") !== "save-note") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    try {
      return deleteNote(repoRoot, c.req.param("id"))
        ? c.json({ ok: true })
        : c.json({ error: "笔记不存在" }, 404);
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500);
    }
  });

  // 变更对比要导出基线快照、写 .repolens/baselines，按写操作要求本地意图标记。
  // 对比的是当前索引（上次扫描时的代码），不在这里顺带重扫。
  app.post("/changes", async (c) => {
    if (c.req.header("x-repolens-intent") !== "compare-changes") {
      return c.json({ error: "缺少 RepoLens 本地写操作标记" }, 403);
    }
    try {
      return c.json(await buildChangeReport(repoRoot, { base: c.req.query("base")?.trim() || "HEAD" }));
    } catch (err) {
      return c.json({ error: (err as Error).message }, err instanceof BaselineError ? 400 : 500);
    }
  });

  app.get("/commits", (c) => c.json(listCommits(repoRoot, clampInt(c.req.query("limit"), 60, 1, 300))));

  app.get("/source/:id", (c) => {
    const id = numericId(c.req.param("id"));
    if (id === null) return c.json({ error: "非法的文件 id" }, 400);
    const from = optionalInt(c.req.query("from"));
    const to = optionalInt(c.req.query("to"));
    const slice = getSource(db, repoRoot, id, from, to);
    return slice ? c.json(slice) : c.json({ error: "源码不可读" }, 404);
  });

  // 没有 README 是常态，回 null 而不是 404
  app.get("/readme", (c) => c.json(getScopeReadme(db, repoRoot, c.req.query("node") ?? "")));

  app.get("/search", (c) => {
    const q = c.req.query("q") ?? "";
    return c.json(
      search(db, q, clampInt(c.req.query("limit"), 30, 1, 100), parseRoles(c.req.query("roles"))),
    );
  });

  return app;
}

async function jsonBody(c: Context): Promise<Record<string, unknown> | null> {
  try {
    const body = (await c.req.json()) as unknown;
    return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isHow(value: unknown): value is UnderstandingHow {
  return value === "manual" || value === "walk" || value === "review";
}

function parseLayers(raw: unknown): ConfirmedLayer[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const layers: ConfirmedLayer[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const layer = item as Record<string, unknown>;
    const name = typeof layer["name"] === "string" ? layer["name"].trim().slice(0, 80) : "";
    const members = Array.isArray(layer["members"])
      ? layer["members"].filter((m): m is string => typeof m === "string" && /^(?:pkg|dir):./.test(m))
      : [];
    if (name === "" || members.length === 0) return null;
    const description = typeof layer["description"] === "string" && layer["description"].trim() !== ""
      ? layer["description"].trim().slice(0, 400)
      : null;
    layers.push({ name, description, members });
  }
  return layers;
}

function repoFile(c: Context, run: () => unknown) {
  try {
    return c.json(run());
  } catch (err) {
    if (err instanceof RepoFileError) return c.json({ error: err.message }, err.status);
    throw err;
  }
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
