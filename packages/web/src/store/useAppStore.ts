import type {
  Confidence,
  FileRole,
  GraphDto,
  GraphNodeDto,
  OverviewDto,
  RepoEntry,
} from "@repolens/core/types";
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { GraphSlice } from "../graph/model";
import { api, getActiveRepo, setActiveRepo } from "../api/client";

export type MetricKey = "loc" | "complexity" | "symbols";

export const SOURCE_ONLY_ROLES: FileRole[] = ["source"];
export const ALL_VISIBLE_ROLES: FileRole[] = ["source", "test", "config", "generated", "types"];

/**
 * 每个作用域默认展示的子节点数。
 *
 * 上限不是性能问题而是可读性问题：一个目录里放 30 个同级节点，
 * ELK 会把容器铺到六千像素宽，自动适配后缩放掉到 0.3，文字全变噪点。
 * 12 个正好能在一屏里读清，剩下的收进聚合节点，用户想看再展开。
 */
const BASE_LIMIT = 12;

/**
 * 默认只画能证明的调用边。
 *
 * ambiguous 是「同名候选不止一个，我挑了第一个」，把它混进默认视图
 * 就是拿猜测冒充事实。要看的人可以自己打开，那时它是明确的一次选择。
 */
export const DEFAULT_CONFIDENCE: Confidence[] = ["exact", "likely"];

/** 调用图作为一个合成作用域塞进 subgraphs，渲染层不需要知道它的存在 */
const callScope = (symbolId: number) => `call:${symbolId}`;

export interface CallGraphMode {
  scopeId: string;
  symbolId: number;
  label: string;
  depth: number;
  direction: "callers" | "callees" | "both";
}

export interface AppState {
  overview: OverviewDto | null;
  bootError: string | null;

  /** 扫过的仓库清单，供顶栏切换 */
  repos: RepoEntry[];
  /** 当前浏览的仓库 id；null 表示还没取到清单 */
  repoId: string | null;
  refreshRepos: () => Promise<void>;
  switchRepo: (id: string) => Promise<void>;
  forgetRepo: (id: string) => Promise<void>;

  rootScope: string;
  /** 每个已加载作用域的一层子图 */
  subgraphs: Record<string, GraphDto>;
  loadingScopes: string[];
  /** 请求过更大 limit 的作用域（展开聚合节点后） */
  scopeLimits: Record<string, number>;
  /** 已就地展开的节点 id，有序 */
  expanded: string[];

  focus: string | null;
  focusDepth: number;

  selected: string | null;
  hovered: string | null;
  hoverAnchor: { x: number; y: number } | null;

  drawerOpen: boolean;
  treeOpen: boolean;
  filterOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  repoPickerOpen: boolean;

  showNoise: boolean;
  showExternal: boolean;
  metric: MetricKey;
  confidence: Confidence[];

  /** 非 null 时画布显示以某个符号为中心的调用图，而不是结构下钻 */
  callGraph: CallGraphMode | null;
  openCallGraph: (symbolId: number, label: string) => Promise<void>;
  closeCallGraph: () => void;
  setCallDepth: (depth: number) => Promise<void>;
  setCallDirection: (direction: CallGraphMode["direction"]) => Promise<void>;
  setConfidence: (confidence: Confidence[]) => Promise<void>;

  /** 非 null 时主区域切换到独立的时序/泳道链路视图。 */
  traceId: string | null;
  traceLabel: string | null;
  openTrace: (id: string, label: string) => void;
  closeTrace: () => void;

  boot: () => Promise<void>;
  loadScope: (scopeId: string, limitOverride?: number, keep?: string) => Promise<void>;
  toggleExpand: (node: GraphNodeDto) => Promise<void>;
  collapse: (nodeId: string) => void;
  select: (nodeId: string | null) => void;
  /** 展开到目标节点所在层并选中它。搜索结果和体检清单都靠它把图带过去 */
  reveal: (nodeId: string) => Promise<void>;
  /** 最近一次 reveal 的目标，供画布把视口移过去；消费后清空 */
  revealed: string | null;
  clearRevealed: () => void;
  hover: (nodeId: string | null, anchor?: { x: number; y: number }) => void;
  setFocus: (nodeId: string | null, depth?: number) => void;
  hideBranch: (nodeId: string) => void;

  /** 内部使用：按当前模式参数重新拉取调用图 */
  loadCallGraph: (mode: CallGraphMode) => Promise<void>;

  setDrawerOpen: (open: boolean) => void;
  panelTab: "tree" | "findings" | "traces";
  setPanelTab: (tab: "tree" | "findings" | "traces") => void;
  setTreeOpen: (open: boolean) => void;
  setFilterOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setRepoPickerOpen: (open: boolean) => void;

  setShowNoise: (value: boolean) => void;
  setShowExternal: (value: boolean) => void;
  setMetric: (value: MetricKey) => void;

  /** Esc 的逐层退回，见 docs/INTERACTION.md 手势语义表 */
  escape: () => void;

  hiddenNodes: string[];
  resetHidden: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
  overview: null,
  bootError: null,

  repos: [],
  // 模块加载时就从 URL 恢复，确保首个 /overview 请求不会先读到启动仓库。
  repoId: getActiveRepo() ?? null,

  rootScope: "dir:.",
  subgraphs: {},
  loadingScopes: [],
  scopeLimits: {},
  expanded: [],

  focus: null,
  focusDepth: 1,

  selected: null,
  hovered: null,
  hoverAnchor: null,

  drawerOpen: false,
  treeOpen: false,
  panelTab: "tree",
  revealed: null,
  filterOpen: false,
  paletteOpen: false,
  helpOpen: false,
  repoPickerOpen: false,

  showNoise: false,
  showExternal: false,
  metric: "loc",
  confidence: DEFAULT_CONFIDENCE,

  callGraph: null,
  traceId: null,
  traceLabel: null,

  hiddenNodes: [],

  async boot() {
    // 先取清单以验证 URL 里的 repo。无效、已移走或索引缺失时回退到
    // 服务启动仓库，避免一个过期书签把页面永久卡在错误页。
    try {
      const { current, repos } = await api.repos();
      const requested = get().repoId;
      const selected = requested && repos.some((repo) => repo.id === requested && repo.status === "ok")
        ? requested
        : current;
      setActiveRepo(selected);
      set({ repos, repoId: selected });
    } catch {
      // 清单不可用时仍尝试当前 URL/服务缺省仓库，保持原有降级能力。
    }

    try {
      const overview = await api.overview();
      set({ overview, bootError: null });
      await get().loadScope(get().rootScope);
    } catch (err) {
      set({ bootError: (err as Error).message });
    }
  },

  async switchRepo(id) {
    // 即使已经是当前仓库，也要把 URL 补齐；例如首次从无参数地址打开。
    setActiveRepo(id);
    if (id === get().repoId) return;
    // 视图状态全部丢掉：展开的层级、选中项、隐藏项都是上一个仓库的节点 id，
    // 留着会让新仓库的图上凭空多出几层展不开的空壳。
    // 但偏好（噪音、外部依赖、指标、置信度、面板开合）是跟着人的，不重置。
    set({
      repoId: id,
      overview: null,
      bootError: null,
      subgraphs: {},
      loadingScopes: [],
      scopeLimits: {},
      expanded: [],
      focus: null,
      selected: null,
      hovered: null,
      hoverAnchor: null,
      drawerOpen: false,
      callGraph: null,
      traceId: null,
      traceLabel: null,
      hiddenNodes: [],
      revealed: null,
    });
    await get().boot();
  },

  async refreshRepos() {
    const { current, repos } = await api.repos();
    set({ repos, repoId: get().repoId ?? current });
  },

  async forgetRepo(id) {
    await api.forgetRepo(id);
    set((state) => ({ repos: state.repos.filter((r) => r.id !== id) }));
  },

  async loadScope(scopeId, limitOverride, keep) {
    const { loadingScopes, showNoise, showExternal, scopeLimits } = get();
    if (loadingScopes.includes(scopeId)) return;

    const limit = limitOverride ?? scopeLimits[scopeId] ?? BASE_LIMIT;
    set({ loadingScopes: [...loadingScopes, scopeId] });

    try {
      const graph = await api.graph({
        scope: scopeId,
        limit,
        roles: (showNoise ? ALL_VISIBLE_ROLES : SOURCE_ONLY_ROLES).join(","),
        external: showExternal && scopeId === get().rootScope,
        keep,
      });
      set((state) => ({
        subgraphs: { ...state.subgraphs, [scopeId]: graph },
        scopeLimits: { ...state.scopeLimits, [scopeId]: limit },
      }));
    } catch (err) {
      // 单个作用域加载失败不该清空整张图，把它当成空子图处理
      set((state) => ({
        subgraphs: { ...state.subgraphs, [scopeId]: { nodes: [], edges: [], truncated: 0 } },
        bootError: state.overview === null ? (err as Error).message : state.bootError,
      }));
    } finally {
      set((state) => ({ loadingScopes: state.loadingScopes.filter((s) => s !== scopeId) }));
    }
  },

  async openCallGraph(symbolId, label) {
    const scopeId = callScope(symbolId);
    const mode: CallGraphMode = {
      scopeId,
      symbolId,
      label,
      depth: get().callGraph?.depth ?? 1,
      direction: get().callGraph?.direction ?? "both",
    };
    // 先切模式再取数：否则要等一个来回画布才有反应，看起来像点击丢了
    set({ callGraph: mode, traceId: null, traceLabel: null, selected: `sym:${symbolId}`, drawerOpen: false });
    await get().loadCallGraph(mode);
  },

  closeCallGraph() {
    set({ callGraph: null });
  },

  openTrace(id, label) {
    set({ traceId: id, traceLabel: label, callGraph: null, drawerOpen: false, selected: null });
  },

  closeTrace() {
    set({ traceId: null, traceLabel: null });
  },

  async setCallDepth(depth) {
    const current = get().callGraph;
    if (!current) return;
    const next = { ...current, depth };
    set({ callGraph: next });
    await get().loadCallGraph(next);
  },

  async setCallDirection(direction) {
    const current = get().callGraph;
    if (!current) return;
    const next = { ...current, direction };
    set({ callGraph: next });
    await get().loadCallGraph(next);
  },

  async setConfidence(confidence) {
    set({ confidence });
    const current = get().callGraph;
    if (current) await get().loadCallGraph(current);
  },

  async loadCallGraph(mode) {
    try {
      const graph = await api.callGraph(mode.symbolId, {
        depth: mode.depth,
        direction: mode.direction,
        confidence: get().confidence.join(","),
      });
      set((state) => ({ subgraphs: { ...state.subgraphs, [mode.scopeId]: graph } }));
    } catch {
      set((state) => ({
        subgraphs: { ...state.subgraphs, [mode.scopeId]: { nodes: [], edges: [], truncated: 0 } },
      }));
    }
  },

  async toggleExpand(node) {
    const { expanded } = get();

    if (expanded.includes(node.id)) {
      get().collapse(node.id);
      return;
    }

    if (!node.expandable) return;

    // 聚合节点没有独立的子图，它的「展开」等价于把父作用域的上限抬高重新取
    if (node.kind === "aggregate") {
      const parentScope = node.id.slice("agg:".length);
      const current = get().scopeLimits[parentScope] ?? BASE_LIMIT;
      await get().loadScope(parentScope, current + node.childCount + 1);
      return;
    }

    set({ expanded: [...expanded, node.id] });
    if (!get().subgraphs[node.id]) await get().loadScope(node.id);
  },

  async reveal(nodeId) {
    // 调用图模式下坐标系完全不同，先退回结构视图再导航
    if (get().callGraph !== null || get().traceId !== null) {
      set({ callGraph: null, traceId: null, traceLabel: null });
    }

    try {
      const { chain } = await api.revealChain(nodeId);
      // 必须顺序展开：每一层的子图要等父层加载完才知道该请求哪个作用域。
      // 每层都带上 keep，因为目标的祖先同样可能因为体量小被折进聚合节点。
      for (const [i, scope] of chain.entries()) {
        if (!get().expanded.includes(scope)) {
          set({ expanded: [...get().expanded, scope] });
        }
        const next = chain[i + 1] ?? nodeId;
        await get().loadScope(scope, get().scopeLimits[scope], next);
      }
      // 根作用域也要锁一次：包/顶层目录多的仓库里，目标所在的那个包
      // 自己就可能在根视图里被折叠
      const root = get().rootScope;
      await get().loadScope(root, get().scopeLimits[root], chain[0] ?? nodeId);
      set({ revealed: nodeId });
    } catch {
      // 链子拿不到就退化成只选中，至少详情抽屉还能看
    }

    get().select(nodeId);
  },

  collapse(nodeId) {
    set((state) => ({
      // 收起一个节点时，它内部所有已展开的后代也要一起收起，
      // 否则再次展开会突然涌出一堆上次留下的层级
      expanded: state.expanded.filter((id) => id !== nodeId && !isDescendantScope(state, id, nodeId)),
    }));
  },

  select(nodeId) {
    set({ selected: nodeId, drawerOpen: nodeId !== null });
  },

  hover(nodeId, anchor) {
    set({ hovered: nodeId, hoverAnchor: anchor ?? null });
  },

  setFocus(nodeId, depth) {
    set({ focus: nodeId, focusDepth: depth ?? get().focusDepth });
  },

  hideBranch(nodeId) {
    set((state) => ({ hiddenNodes: [...new Set([...state.hiddenNodes, nodeId])] }));
  },

  resetHidden() {
    set({ hiddenNodes: [] });
  },

  clearRevealed() {
    set({ revealed: null });
  },

  setPanelTab(tab) {
    set({ panelTab: tab });
  },

  setDrawerOpen(open) {
    set({ drawerOpen: open });
  },
  setTreeOpen(open) {
    set({ treeOpen: open });
  },
  setFilterOpen(open) {
    set({ filterOpen: open });
  },
  setPaletteOpen(open) {
    set({ paletteOpen: open });
  },
  setHelpOpen(open) {
    set({ helpOpen: open });
  },
  setRepoPickerOpen(open) {
    set({ repoPickerOpen: open });
  },

  setShowNoise(value) {
    set({ showNoise: value, subgraphs: {}, scopeLimits: {} });
    void get().loadScope(get().rootScope);
    for (const id of get().expanded) void get().loadScope(id);
  },

  setShowExternal(value) {
    set({ showExternal: value, subgraphs: {}, scopeLimits: {} });
    void get().loadScope(get().rootScope);
    for (const id of get().expanded) void get().loadScope(id);
  },

  setMetric(value) {
    set({ metric: value });
  },

  escape() {
    const state = get();
    if (state.paletteOpen) return set({ paletteOpen: false });
    if (state.helpOpen) return set({ helpOpen: false });
    if (state.repoPickerOpen) return set({ repoPickerOpen: false });
    if (state.filterOpen) return set({ filterOpen: false });
    if (state.drawerOpen) return set({ drawerOpen: false });
    if (state.traceId !== null) return set({ traceId: null, traceLabel: null });
    if (state.selected !== null) return set({ selected: null });
    if (state.focus !== null) return set({ focus: null });
    // 退出调用图排在展开状态之前：它是一次「换了张图」，比收起层级更外层
    if (state.callGraph !== null) return set({ callGraph: null });
    if (state.hiddenNodes.length > 0) return set({ hiddenNodes: [] });
    if (state.expanded.length > 0) return set({ expanded: [] });
    if (state.treeOpen) return set({ treeOpen: false });
    return undefined;
  },
}));

/**
 * 只订阅决定图结构的四个字段。
 *
 * 用 useShallow 是必须的：选择器返回新对象，没有浅比较的话每次
 * store 变动都会判定为「变了」，收窄订阅就白做了。
 */
export function useGraphSlice(): GraphSlice {
  return useAppStore(
    useShallow((s) => ({
      // 调用图是扁平的，把它当成一个没有展开项的作用域交给同一套拼图逻辑，
      // 画布、布局、hover 高亮全都不需要为它加分支
      rootScope: s.callGraph?.scopeId ?? s.rootScope,
      subgraphs: s.subgraphs,
      expanded: s.callGraph ? EMPTY : s.expanded,
      hiddenNodes: s.hiddenNodes,
    })),
  );
}

/** 稳定的空数组引用，避免每次选择器求值都产生新对象破坏浅比较 */
const EMPTY: string[] = [];

/** 判断 candidate 这个已展开节点是否落在 ancestor 的子树里 */
function isDescendantScope(state: AppState, candidate: string, ancestor: string): boolean {
  const graph = state.subgraphs[ancestor];
  if (!graph) return false;
  if (graph.nodes.some((n) => n.id === candidate)) return true;
  return graph.nodes.some((n) => isDescendantScope(state, candidate, n.id));
}
