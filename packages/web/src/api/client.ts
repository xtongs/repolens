import type {
  BoundaryDto,
  ChangeReportDto,
  CommitDto,
  ChatContextItemDto,
  ChatDoneDto,
  ChatRequestDto,
  ChatToolStepDto,
  ConfirmedLayer,
  FileDetailDto,
  FindingDto,
  FindingKind,
  FindingSummaryDto,
  GraphDto,
  LensKind,
  LensValueDto,
  ModuleCardDto,
  NoteDto,
  NoteInputDto,
  OverviewDto,
  PickRepoResultDto,
  ReadmeDto,
  RepoScanTaskDto,
  ReposDto,
  SearchHitDto,
  SemanticResultDto,
  SkeletonDto,
  SourceSliceDto,
  SpecDto,
  SymbolDetailDto,
  TourDto,
  TreeNodeDto,
  TypeFlowDto,
  EntryPointDto,
  UnderstandingDto,
  UnderstandingHow,
  UnderstandingMarkDto,
  WalkFrameDto,
} from "@repolens/core/types";
import { t, translateMessage } from "../i18n";

const BASE = "/api";

/**
 * 当前浏览的仓库。
 *
 * 放在模块作用域而不是穿过每个调用点，理由和 BASE 一样：它是「往哪儿发请求」
 * 的一部分，不是某次查询的参数。二十多处调用点全都加一个 repoId 形参，
 * 只会让每一层都得记着往下传，漏一处就静默地查到了另一个仓库。
 *
 * 留 undefined 时服务端落到启动时那个仓库，所以首屏不必先取一次清单
 * 才敢发第一个请求。
 */
let activeRepo: string | undefined = repoFromLocation();

/** 当前 URL 指定的仓库。Store 首次启动用它恢复刷新前的选择。 */
export function getActiveRepo(): string | undefined {
  return activeRepo;
}

export function setActiveRepo(id: string | undefined): void {
  activeRepo = id;
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  if (id === undefined || id === "") url.searchParams.delete("repo");
  else url.searchParams.set("repo", id);
  window.history.replaceState(window.history.state, "", url);
}

function repoFromLocation(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const value = new URL(window.location.href).searchParams.get("repo")?.trim();
  return value ? value : undefined;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function get<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  repo: string | undefined = activeRepo,
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  if (repo !== undefined) search.set("repo", repo);
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query.length > 0 ? `?${query}` : ""}`);

  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function post<T>(
  path: string,
  params: Record<string, string | number | boolean | undefined> = {},
  intent = "generate-semantic",
): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  if (activeRepo !== undefined) search.set("repo", activeRepo);
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query.length > 0 ? `?${query}` : ""}`, {
    method: "POST",
    headers: { "x-repolens-intent": intent },
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function send<T>(
  method: "POST" | "DELETE",
  path: string,
  intent: string,
  body?: unknown,
  params: Record<string, string> = {},
): Promise<T> {
  const search = new URLSearchParams(params);
  if (activeRepo !== undefined) search.set("repo", activeRepo);
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query.length > 0 ? `?${query}` : ""}`, {
    method,
    headers: {
      "x-repolens-intent": intent,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw await toError(response);
  return (await response.json()) as T;
}

async function toError(response: Response): Promise<ApiError> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) detail = body.error;
  } catch {
    // 响应体不是 JSON 就用状态文本
  }
  return new ApiError(translateMessage(detail), response.status);
}

export interface GraphParams {
  scope?: string;
  limit?: number;
  roles?: string;
  external?: boolean;
  /** 必须出现在结果里、不允许被折叠的节点 id */
  keep?: string;
}

export interface CallGraphParams {
  depth?: number;
  direction?: "callers" | "callees" | "both";
  limit?: number;
  /** 逗号分隔的置信度档位 */
  confidence?: string;
}

export interface FindingsResponse {
  summary: FindingSummaryDto;
  items: FindingDto[];
}

/** 盯着文件变化的状态，和服务端 WatchManager 的一致 */
export interface WatchStatusDto {
  enabled: boolean;
  refreshing: boolean;
  refreshedAt: string | null;
  error: string | null;
}

export interface RepoEventHandlers {
  onStatus: (status: WatchStatusDto) => void;
  /** 索引已经按最新的文件刷新完 */
  onIndex: (refreshedAt: string) => void;
}

export const api = {
  repos: () => get<ReposDto>("/repos"),

  pickAndScanRepo: () =>
    post<PickRepoResultDto>("/repos/pick-and-scan", {}, "scan-repository"),

  repoScans: () => get<{ tasks: RepoScanTaskDto[] }>("/repo-scans"),

  repoScan: (id: string) => get<RepoScanTaskDto>(`/repo-scans/${encodeURIComponent(id)}`),

  rescanRepo: (id: string) =>
    post<RepoScanTaskDto>(`/repos/${encodeURIComponent(id)}/scan`, {}, "scan-repository"),

  forgetRepo: async (id: string): Promise<void> => {
    const response = await fetch(`${BASE}/repos/${id}`, { method: "DELETE" });
    if (!response.ok) throw await toError(response);
  },

  findings: (kind?: FindingKind, scope?: string) =>
    get<FindingsResponse>("/findings", { kind, scope }),

  revealChain: (nodeId: string) =>
    get<{ chain: string[] }>(`/reveal/${nodeId}`),

  overview: () => get<OverviewDto>("/overview"),

  /** 读取仓库列表中任意仓库的概览，不切换当前仓库或改写 URL。 */
  repoOverview: (id: string) => get<OverviewDto>("/overview", {}, id),

  tree: (path: string, depth = 1, roles?: string) =>
    get<TreeNodeDto>("/tree", { path, depth, roles }),

  /** 结构树的一层：磁盘上的全部条目，每项带 status 说明是否参与分析 */
  files: (path: string) => get<TreeNodeDto>("/files", { path }),

  graph: (params: GraphParams) =>
    get<GraphDto>("/graph", {
      scope: params.scope,
      limit: params.limit,
      roles: params.roles,
      external: params.external ? 1 : undefined,
      keep: params.keep,
    }),

  callGraph: (symbolId: number, params: CallGraphParams = {}) =>
    get<GraphDto>(`/callgraph/${symbolId}`, {
      depth: params.depth,
      direction: params.direction,
      limit: params.limit,
      confidence: params.confidence,
    }),

  entries: () => get<EntryPointDto[]>("/entries"),

  /** 首次对比某个提交要导出快照并建基线索引，可能要几秒 */
  changes: (base: string) => post<ChangeReportDto>("/changes", { base }, "compare-changes"),

  /** 动过扫描根的最近提交，新的在前；不在 git 里时为空 */
  commits: () => get<CommitDto[]>("/commits"),

  walk: (symbolId: string) => get<WalkFrameDto>(`/walk/${stripPrefix(symbolId)}`),

  file: (id: string) => get<FileDetailDto>(`/file/${stripPrefix(id)}`),

  symbol: (id: string) => get<SymbolDetailDto>(`/symbol/${stripPrefix(id)}`),

  generateSymbolSemantics: (id: string, refresh = false) =>
    post<SemanticResultDto>(`/semantic/symbol/${stripPrefix(id)}`, {
      refresh: refresh ? 1 : undefined,
    }),

  generateFileSummary: (id: string, refresh = false) =>
    post<SemanticResultDto>(`/semantic/file/${stripPrefix(id)}`, {
      refresh: refresh ? 1 : undefined,
    }),

  source: (fileId: string, from?: number, to?: number) =>
    get<SourceSliceDto>(`/source/${stripPrefix(fileId)}`, { from, to }),

  /** 没进索引的文件按仓库相对路径读原文 */
  rawSource: (path: string) => get<SourceSliceDto>("/raw", { path }),

  /** 包 / 目录这一层的 README，没有时是 null */
  readme: (nodeId: string) => get<ReadmeDto | null>("/readme", { node: nodeId }),

  search: (q: string, limit = 30, roles?: string) =>
    get<SearchHitDto[]>("/search", { q, limit, roles }),

  notes: () => get<{ notes: NoteDto[] }>("/notes"),

  addNote: (input: NoteInputDto) => send<NoteDto>("POST", "/notes", "save-note", input),

  deleteNote: (id: string) => send<{ ok: true }>("DELETE", `/notes/${encodeURIComponent(id)}`, "save-note"),

  /** 架构图上一条边由什么构成；没有直接依赖时带最短的一条 import 链 */
  boundary: (from: string, to: string, roles?: string) => get<BoundaryDto>("/boundary", { from, to, roles }),

  moduleCard: (nodeId: string) => get<ModuleCardDto>("/module", { node: nodeId }),

  spec: (nodeId: string) => get<SpecDto>("/spec", { node: nodeId }),

  typeFlow: (id: string) => get<TypeFlowDto>(`/typeflow/${stripPrefix(id)}`),

  skeleton: () => get<SkeletonDto>("/skeleton"),

  lens: (kind: LensKind, ids: string[]) => get<Record<string, LensValueDto>>("/lens", { kind, ids: ids.join(",") }),

  understanding: () => get<UnderstandingDto>("/understanding"),

  markUnderstood: (nodeId: string, how: UnderstandingHow = "manual") =>
    send<UnderstandingMarkDto>("POST", "/understanding", "understanding", { nodeId, how }),

  unmarkUnderstood: (key: string) => send<{ ok: true }>("DELETE", "/understanding", "understanding", undefined, { key }),

  tours: () => get<{ tours: TourDto[] }>("/tours"),

  /** 写进仓库根目录的 .repolens.json，随代码提交 */
  saveTour: (tour: TourDto) => send<TourDto>("POST", "/tours", "save-tour", { tour }),

  deleteTour: (id: string) => send<{ ok: true }>("DELETE", `/tours/${encodeURIComponent(id)}`, "save-tour"),

  confirmLayers: (layers: ConfirmedLayer[]) =>
    send<{ layers: ConfirmedLayer[] }>("POST", "/layers/confirm", "confirm-layers", { layers }),

  /** 把现在的模块间依赖记成批准过的清单（.repolens.lock.json） */
  writeLock: () => send<{ level: "package" | "directory"; dependencies: number }>("POST", "/lock", "write-lock"),

  /** 只刷新结构、不调用模型的增量扫描，跑完才返回；refreshedAt 和同时推出的 index 事件里的一致 */
  refreshIndex: (repoId: string) =>
    send<{ ok: true; refreshedAt: string }>("POST", `/repos/${encodeURIComponent(repoId)}/refresh`, "scan-repository"),

  watchStatus: (repoId: string) => get<WatchStatusDto>(`/repos/${encodeURIComponent(repoId)}/watch`),

  setWatch: (repoId: string, enabled: boolean) =>
    send<WatchStatusDto>("POST", `/repos/${encodeURIComponent(repoId)}/watch`, "watch-repository", { enabled }),

  chat: streamChat,
};

/**
 * 订阅一个仓库的实时事件：watch 状态变化、索引刷新完成。EventSource 断线会自己重连，
 * 重连后服务端先推一次当前状态，界面不会停在过期的状态上。返回取消订阅的函数。
 */
export function subscribeRepoEvents(repoId: string, handlers: RepoEventHandlers): () => void {
  if (typeof EventSource === "undefined") return () => {};
  const source = new EventSource(`${BASE}/repos/${encodeURIComponent(repoId)}/events`);
  source.addEventListener("status", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { status?: WatchStatusDto };
    if (payload.status) handlers.onStatus(payload.status);
  });
  source.addEventListener("index", (event) => {
    const payload = JSON.parse((event as MessageEvent<string>).data) as { refreshedAt?: string };
    handlers.onIndex(payload.refreshedAt ?? new Date().toISOString());
  });
  return () => source.close();
}

export interface ChatStreamHandlers {
  onContext?: (items: ChatContextItemDto[]) => void;
  onDelta: (text: string) => void;
  onTool?: (step: ChatToolStepDto) => void;
}

/**
 * 追问 AI。EventSource 只能发 GET，而问题和上下文引用要放在请求体里，
 * 所以用 fetch 读流、手工切 SSE 事件。
 */
async function streamChat(
  request: ChatRequestDto,
  handlers: ChatStreamHandlers,
  signal?: AbortSignal,
): Promise<ChatDoneDto> {
  const query = activeRepo !== undefined ? `?repo=${encodeURIComponent(activeRepo)}` : "";
  const response = await fetch(`${BASE}/chat${query}`, {
    method: "POST",
    headers: { "x-repolens-intent": "chat", "content-type": "application/json" },
    body: JSON.stringify(request),
    signal,
  });
  if (!response.ok) throw await toError(response);
  if (!response.body) throw new ApiError(t("浏览器不支持流式响应"), 0);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  const result: { done: ChatDoneDto | null } = { done: null };

  const dispatch = () => {
    if (data.length === 0) return;
    const payload = JSON.parse(data.join("\n")) as Record<string, unknown>;
    if (event === "delta" && typeof payload["text"] === "string") handlers.onDelta(payload["text"]);
    else if (event === "tool" && typeof payload["id"] === "string") handlers.onTool?.(payload as unknown as ChatToolStepDto);
    else if (event === "context" && Array.isArray(payload["items"])) {
      handlers.onContext?.(payload["items"] as ChatContextItemDto[]);
    } else if (event === "done") result.done = payload as unknown as ChatDoneDto;
    else if (event === "error") throw new ApiError(payload["message"] ? translateMessage(String(payload["message"])) : t("AI 回答失败"), 502);
  };

  while (true) {
    const { value, done: finished } = await reader.read();
    if (finished) break;
    buffer += decoder.decode(value, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") {
        dispatch();
        event = "message";
        data = [];
      } else if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
  }
  dispatch();
  if (result.done === null) throw new ApiError(t("回答在中途断开了"), 0);
  return result.done;
}

function stripPrefix(id: string): string {
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
}
