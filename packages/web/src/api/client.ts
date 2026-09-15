import type {
  FileDetailDto,
  FindingDto,
  FindingSummaryDto,
  GraphDto,
  OverviewDto,
  ReposDto,
  SearchHitDto,
  SourceSliceDto,
  SymbolDetailDto,
  TreeNodeDto,
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
let activeRepo: string | undefined;

export function setActiveRepo(id: string | undefined): void {
  activeRepo = id;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function get<T>(path: string, params: Record<string, string | number | boolean | undefined> = {}): Promise<T> {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }
  if (activeRepo !== undefined) search.set("repo", activeRepo);
  const query = search.toString();
  const response = await fetch(`${BASE}${path}${query.length > 0 ? `?${query}` : ""}`);

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

  forgetRepo: async (id: string): Promise<void> => {
    const response = await fetch(`${BASE}/repos/${id}`, { method: "DELETE" });
    if (!response.ok) throw await toError(response);
  },

  findings: (kind?: "duplicate" | "cycle", scope?: string) =>
    get<FindingsResponse>("/findings", { kind, scope }),

  revealChain: (nodeId: string) =>
    get<{ chain: string[] }>(`/reveal/${nodeId}`),

  overview: () => get<OverviewDto>("/overview"),

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

  file: (id: string) => get<FileDetailDto>(`/file/${stripPrefix(id)}`),

  symbol: (id: string) => get<SymbolDetailDto>(`/symbol/${stripPrefix(id)}`),

  source: (fileId: string, from?: number, to?: number) =>
    get<SourceSliceDto>(`/source/${stripPrefix(fileId)}`, { from, to }),

  search: (q: string, limit = 30, roles?: string) =>
    get<SearchHitDto[]>("/search", { q, limit, roles }),
};

function stripPrefix(id: string): string {
  const colon = id.indexOf(":");
  return colon >= 0 ? id.slice(colon + 1) : id;
}
