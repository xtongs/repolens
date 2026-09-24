import type {
  ChatContextItemDto,
  ChatDoneDto,
  ChatRequestDto,
  FileDetailDto,
  FindingDto,
  FindingSummaryDto,
  GraphDto,
  OverviewDto,
  PickRepoResultDto,
  RepoScanTaskDto,
  ReposDto,
  SearchHitDto,
  SemanticResultDto,
  SourceSliceDto,
  SymbolDetailDto,
  TreeNodeDto,
  EntryPointDto,
  TraceDto,
  TraceNarrativeResultDto,
  TraceSummaryDto,
} from "@repolens/core/types";

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

async function toError(response: Response): Promise<ApiError> {
  let detail = response.statusText;
  try {
    const body = (await response.json()) as { error?: string };
    if (body.error) detail = body.error;
  } catch {
    // 响应体不是 JSON 就用状态文本
  }
  return new ApiError(detail, response.status);
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

  findings: (kind?: "duplicate" | "cycle", scope?: string) =>
    get<FindingsResponse>("/findings", { kind, scope }),

  revealChain: (nodeId: string) =>
    get<{ chain: string[] }>(`/reveal/${nodeId}`),

  overview: () => get<OverviewDto>("/overview"),

  /** 读取仓库列表中任意仓库的概览，不切换当前仓库或改写 URL。 */
  repoOverview: (id: string) => get<OverviewDto>("/overview", {}, id),

  tree: (path: string, depth = 1, roles?: string) =>
    get<TreeNodeDto>("/tree", { path, depth, roles }),

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

  traces: (entryId?: string) =>
    get<TraceSummaryDto[]>("/traces", { entry: entryId }),

  trace: (id: string) => get<TraceDto>(`/trace/${stripPrefix(id)}`),

  generateTraceNarrative: (id: string) =>
    post<TraceNarrativeResultDto>(`/semantic/trace/${stripPrefix(id)}`),

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

  search: (q: string, limit = 30, roles?: string) =>
    get<SearchHitDto[]>("/search", { q, limit, roles }),

  chat: streamChat,
};

export interface ChatStreamHandlers {
  onContext?: (items: ChatContextItemDto[]) => void;
  onDelta: (text: string) => void;
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
  if (!response.body) throw new ApiError("浏览器不支持流式响应", 0);

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
    else if (event === "context" && Array.isArray(payload["items"])) {
      handlers.onContext?.(payload["items"] as ChatContextItemDto[]);
    } else if (event === "done") result.done = payload as unknown as ChatDoneDto;
    else if (event === "error") throw new ApiError(String(payload["message"] ?? "AI 回答失败"), 502);
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
  if (result.done === null) throw new ApiError("回答在中途断开了", 0);
  return result.done;
}

function stripPrefix(id: string): string {
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
}
