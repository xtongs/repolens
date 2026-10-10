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
import { readPref, writePref } from "../lib/prefs";

export type MetricKey = "loc" | "complexity" | "symbols";

/** 看图的设置和侧栏开合跟着用户走，下次打开还是上次的样子；看到哪、选了什么不算设置，不记 */
const PREF = {
  metric: "repolens:metric",
  noise: "repolens:show-noise",
  external: "repolens:show-external",
  confidence: "repolens:call-confidence",
  callDepth: "repolens:call-depth",
  callDirection: "repolens:call-direction",
  walkAllCalls: "repolens:walk-all-calls",
  treeOpen: "repolens:left-panel-open",
  panelTab: "repolens:left-panel-tab",
  chatOpen: "repolens:chat-open",
} as const;

function savedChoice<T extends string>(key: string, choices: readonly T[], fallback: T): T {
  const value = readPref(key);
  return choices.includes(value as T) ? (value as T) : fallback;
}

function savedConfidence(): Confidence[] {
  const choices: Confidence[] = ["exact", "likely", "ambiguous", "external", "unresolved"];
  const saved = (readPref(PREF.confidence) ?? "").split(",").filter((value): value is Confidence =>
    choices.includes(value as Confidence));
  return saved.length > 0 ? saved : DEFAULT_CONFIDENCE;
}

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

export type PanelTab = "tree" | "findings" | "entries" | "changes";

/** 走读调用栈里的一帧 */
export interface WalkFrameRef {
  /** 函数 id，`sym:N` */
  id: string;
  /** 帧数据到之前顶栏和面包屑先用它 */
  name: string;
  /** 停在哪处调用上（`call:N`）；null 表示停在函数开头 */
  at: string | null;
}

export interface WalkState {
  /** 从哪里开始走的：入口名或函数名 */
  label: string;
  /** 自入口起的调用栈，最后一帧是正在看的函数 */
  stack: WalkFrameRef[];
}

export interface DetailRequest {
  nodeId: string;
  tab: "source" | "notes";
  lines: [number, number] | null;
}

export interface AppState {
  overview: OverviewDto | null;
  bootError: string | null;

  /** 扫过的仓库清单，供顶栏切换 */
  repos: RepoEntry[];
  /** 当前浏览的仓库 id；null 表示还没取到清单 */
  repoId: string | null;
  /** 清单里没有一个能打开的仓库，也没有启动仓库。桌面端首次启动就是这样 */
  noRepo: boolean;
  /** 每次请求「添加仓库」时递增；仓库选择器据此弹出目录选择 */
  addRepoRequest: number;
  requestAddRepo: () => void;
  /** 只重取概览，不动图。改完 AI 设置后用它刷新顶栏状态 */
  refreshOverview: () => Promise<void>;
  /** 切换仓库或重扫当前仓库时递增，用来使本地视图和异步请求失效。 */
  repoRevision: number;
  refreshRepos: () => Promise<void>;
  switchRepo: (id: string, forceReload?: boolean) => Promise<void>;
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
  /** 追问 AI 面板。和详情抽屉共用右侧栏：有选中项时停靠在详情下方，没有时独占 */
  chatOpen: boolean;
  treeOpen: boolean;
  filterOpen: boolean;
  paletteOpen: boolean;
  helpOpen: boolean;
  repoPickerOpen: boolean;
  /** 桌面端的 AI 设置弹窗 */
  settingsOpen: boolean;

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

  /** 非 null 时主区域换成单步走读：沿调用逐个看函数体，可以步入、步出 */
  walk: WalkState | null;
  openWalk: (symbolId: string, label: string) => void;
  setWalkStack: (stack: WalkFrameRef[]) => void;
  closeWalk: () => void;
  /** 走读时把外部库和解析不了的调用也列为步骤 */
  walkAllCalls: boolean;
  setWalkAllCalls: (value: boolean) => void;

  boot: () => Promise<void>;
  loadScope: (scopeId: string, limitOverride?: number, keep?: string) => Promise<void>;
  toggleExpand: (node: GraphNodeDto) => Promise<void>;
  collapse: (nodeId: string) => void;
  select: (nodeId: string | null) => void;
  /** 展开到目标节点所在层并选中它。搜索结果和体检清单都靠它把图带过去 */
  reveal: (nodeId: string) => Promise<void>;
  /** 结构树里点一项：结构视图下展开到它并居中；走读和调用图里只选中，不把人从眼前的视图拽走 */
  locate: (nodeId: string) => void;
  /** 最近一次 reveal 的目标，供画布把视口移过去；消费后清空 */
  revealed: string | null;
  clearRevealed: () => void;
  /** 定位到节点，并让详情打开指定的页签（有行号时滚到那几行）。详情消费后清空 */
  detailRequest: DetailRequest | null;
  /** reveal 为 false 时只打开详情，画布不动：画布上本来就不显示的文件没必要去找 */
  openDetail: (nodeId: string, request: Omit<DetailRequest, "nodeId">, reveal?: boolean) => void;
  clearDetailRequest: () => void;
  hover: (nodeId: string | null, anchor?: { x: number; y: number }) => void;
  setFocus: (nodeId: string | null, depth?: number) => void;
  hideBranch: (nodeId: string) => void;

  /** 内部使用：按当前模式参数重新拉取调用图 */
  loadCallGraph: (mode: CallGraphMode) => Promise<void>;

  setDrawerOpen: (open: boolean) => void;
  setChatOpen: (open: boolean) => void;
  panelTab: PanelTab;
  setPanelTab: (tab: PanelTab) => void;
  setTreeOpen: (open: boolean) => void;
  setFilterOpen: (open: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setHelpOpen: (open: boolean) => void;
  setRepoPickerOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;

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
  noRepo: false,
  addRepoRequest: 0,
  repoRevision: 0,

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
  chatOpen: readPref(PREF.chatOpen) === "on",
  treeOpen: readPref(PREF.treeOpen) === "on",
  panelTab: savedChoice<PanelTab>(PREF.panelTab, ["tree", "findings", "entries", "changes"], "tree"),
  revealed: null,
  detailRequest: null,
  filterOpen: false,
  paletteOpen: false,
  helpOpen: false,
  repoPickerOpen: false,
  settingsOpen: false,

  showNoise: readPref(PREF.noise) === "on",
  showExternal: readPref(PREF.external) === "on",
  metric: savedChoice<MetricKey>(PREF.metric, ["loc", "complexity", "symbols"], "loc"),
  confidence: savedConfidence(),

  callGraph: null,
  walk: null,
  walkAllCalls: readPref(PREF.walkAllCalls) === "on",

  hiddenNodes: [],

  async boot() {
    const revision = get().repoRevision;
    // 先取清单以验证 URL 里的 repo。无效、已移走或索引缺失时回退到
    // 服务启动仓库，避免一个过期书签把页面永久卡在错误页。
    try {
      const { current, repos } = await api.repos();
      if (revision !== get().repoRevision) return;
      const requested = get().repoId;
      const selected = requested && repos.some((repo) => repo.id === requested && repo.status === "ok")
        ? requested
        : current ?? repos.find((repo) => repo.status === "ok")?.id ?? null;
      if (selected === null) {
        setActiveRepo(undefined);
        set({ repos, repoId: null, noRepo: true, bootError: null });
        return;
      }
      setActiveRepo(selected);
      set({ repos, repoId: selected, noRepo: false });
    } catch {
      // 清单不可用时仍尝试当前 URL/服务缺省仓库，保持原有降级能力。
    }

    try {
      const overview = await api.overview();
      if (revision !== get().repoRevision) return;
      set({ overview, bootError: null });
      await get().loadScope(get().rootScope);
    } catch (err) {
      if (revision === get().repoRevision) set({ bootError: (err as Error).message });
    }
  },

  async switchRepo(id, forceReload = false) {
    // 即使已经是当前仓库，也要把 URL 补齐；例如首次从无参数地址打开。
    setActiveRepo(id);
    if (id === get().repoId && !forceReload) return;
    const repoRevision = get().repoRevision + 1;
    // 视图状态全部丢掉：展开的层级、选中项、隐藏项都是上一个仓库的节点 id，
    // 留着会让新仓库的图上凭空多出几层展不开的空壳。
    // 但偏好（噪音、外部依赖、指标、置信度、面板开合）是跟着人的，不重置。
    set({
      repoId: id,
      repoRevision,
      noRepo: false,
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
      walk: null,
      hiddenNodes: [],
      revealed: null,
      detailRequest: null,
    });
    await get().boot();
  },

  async refreshRepos() {
    const { current, repos } = await api.repos();
    set({ repos, repoId: get().repoId ?? current });
  },

  requestAddRepo() {
    set((state) => ({ addRepoRequest: state.addRepoRequest + 1 }));
  },

  async refreshOverview() {
    if (get().overview === null) return;
    const revision = get().repoRevision;
    const overview = await api.overview();
    if (revision === get().repoRevision) set({ overview });
  },

  async forgetRepo(id) {
    await api.forgetRepo(id);
    set((state) => ({ repos: state.repos.filter((r) => r.id !== id) }));
  },

  async loadScope(scopeId, limitOverride, keep) {
    const { loadingScopes, showNoise, showExternal, scopeLimits } = get();
    if (loadingScopes.includes(scopeId)) return;
    const revision = get().repoRevision;
    const repoId = get().repoId;

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
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
      set((state) => ({
        subgraphs: { ...state.subgraphs, [scopeId]: graph },
        scopeLimits: { ...state.scopeLimits, [scopeId]: limit },
      }));
    } catch (err) {
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
      // 单个作用域加载失败不该清空整张图，把它当成空子图处理
      set((state) => ({
        subgraphs: { ...state.subgraphs, [scopeId]: { nodes: [], edges: [], truncated: 0 } },
        bootError: state.overview === null ? (err as Error).message : state.bootError,
      }));
    } finally {
      if (revision === get().repoRevision && get().repoId === repoId) {
        set((state) => ({ loadingScopes: state.loadingScopes.filter((s) => s !== scopeId) }));
      }
    }
  },

  async openCallGraph(symbolId, label) {
    const scopeId = callScope(symbolId);
    const mode: CallGraphMode = {
      scopeId,
      symbolId,
      label,
      depth: get().callGraph?.depth ?? Number(savedChoice(PREF.callDepth, ["1", "2", "3"], "1")),
      direction: get().callGraph?.direction ??
        savedChoice<CallGraphMode["direction"]>(PREF.callDirection, ["callers", "callees", "both"], "both"),
    };
    // 先切模式再取数：否则要等一个来回画布才有反应，看起来像点击丢了
    set({ callGraph: mode, walk: null, selected: `sym:${symbolId}`, drawerOpen: false });
    await get().loadCallGraph(mode);
  },

  closeCallGraph() {
    set({ callGraph: null });
  },

  openWalk(symbolId, label) {
    // 两侧栏开着就留着，走读视图会按它们的宽度让出位置
    set({
      walk: { label, stack: [{ id: symbolId, name: label, at: null }] },
      callGraph: null,
    });
  },

  setWalkStack(stack) {
    const walk = get().walk;
    if (walk && stack.length > 0) set({ walk: { ...walk, stack } });
  },

  closeWalk() {
    set({ walk: null });
  },

  setWalkAllCalls(value) {
    writePref(PREF.walkAllCalls, value ? "on" : "off");
    set({ walkAllCalls: value });
  },

  async setCallDepth(depth) {
    const current = get().callGraph;
    if (!current) return;
    const next = { ...current, depth };
    writePref(PREF.callDepth, String(depth));
    set({ callGraph: next });
    await get().loadCallGraph(next);
  },

  async setCallDirection(direction) {
    const current = get().callGraph;
    if (!current) return;
    const next = { ...current, direction };
    writePref(PREF.callDirection, direction);
    set({ callGraph: next });
    await get().loadCallGraph(next);
  },

  async setConfidence(confidence) {
    writePref(PREF.confidence, confidence.join(","));
    set({ confidence });
    const current = get().callGraph;
    if (current) await get().loadCallGraph(current);
  },

  async loadCallGraph(mode) {
    const revision = get().repoRevision;
    const repoId = get().repoId;
    try {
      const graph = await api.callGraph(mode.symbolId, {
        depth: mode.depth,
        direction: mode.direction,
        confidence: get().confidence.join(","),
      });
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
      set((state) => ({ subgraphs: { ...state.subgraphs, [mode.scopeId]: graph } }));
    } catch {
      if (revision !== get().repoRevision || get().repoId !== repoId) return;
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
    const revision = get().repoRevision;
    const repoId = get().repoId;
    const isCurrentRepo = () => revision === get().repoRevision && repoId === get().repoId;
    // 调用图模式下坐标系完全不同，先退回结构视图再导航
    if (get().callGraph !== null || get().walk !== null) {
      set({ callGraph: null, walk: null });
    }

    try {
      const { chain } = await api.revealChain(nodeId);
      if (!isCurrentRepo()) return;
      // 必须顺序展开：每一层的子图要等父层加载完才知道该请求哪个作用域。
      // 每层都带上 keep，因为目标的祖先同样可能因为体量小被折进聚合节点。
      for (const [i, scope] of chain.entries()) {
        if (!get().expanded.includes(scope)) {
          set({ expanded: [...get().expanded, scope] });
        }
        const next = chain[i + 1] ?? nodeId;
        await get().loadScope(scope, get().scopeLimits[scope], next);
        if (!isCurrentRepo()) return;
      }
      // 根作用域也要锁一次：包/顶层目录多的仓库里，目标所在的那个包
      // 自己就可能在根视图里被折叠
      const root = get().rootScope;
      await get().loadScope(root, get().scopeLimits[root], chain[0] ?? nodeId);
      if (!isCurrentRepo()) return;
      set({ revealed: nodeId });
    } catch {
      // 链子拿不到就退化成只选中，至少详情抽屉还能看
    }

    if (isCurrentRepo()) get().select(nodeId);
  },

  locate(nodeId) {
    if (get().walk !== null || get().callGraph !== null) get().select(nodeId);
    else void get().reveal(nodeId);
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

  openDetail(nodeId, request, reveal = true) {
    set({ detailRequest: { nodeId, ...request } });
    if (reveal) void get().reveal(nodeId);
    else get().select(nodeId);
  },

  clearDetailRequest() {
    set({ detailRequest: null });
  },

  setPanelTab(tab) {
    set({ panelTab: tab });
  },

  setDrawerOpen(open) {
    set({ drawerOpen: open });
  },
  setChatOpen(open) {
    set({ chatOpen: open });
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
  setSettingsOpen(open) {
    set({ settingsOpen: open });
  },

  setShowNoise(value) {
    writePref(PREF.noise, value ? "on" : "off");
    set({ showNoise: value, subgraphs: {}, scopeLimits: {} });
    void get().loadScope(get().rootScope);
    for (const id of get().expanded) void get().loadScope(id);
  },

  setShowExternal(value) {
    writePref(PREF.external, value ? "on" : "off");
    set({ showExternal: value, subgraphs: {}, scopeLimits: {} });
    void get().loadScope(get().rootScope);
    for (const id of get().expanded) void get().loadScope(id);
  },

  setMetric(value) {
    writePref(PREF.metric, value);
    set({ metric: value });
  },

  escape() {
    const state = get();
    if (state.settingsOpen) return set({ settingsOpen: false });
    if (state.paletteOpen) return set({ paletteOpen: false });
    if (state.helpOpen) return set({ helpOpen: false });
    if (state.repoPickerOpen) return set({ repoPickerOpen: false });
    if (state.filterOpen) return set({ filterOpen: false });
    // 对话叠在详情之上，先收起它；对话记录保留，再打开还在
    if (state.chatOpen) return set({ chatOpen: false });
    if (state.drawerOpen) return set({ drawerOpen: false });
    if (state.walk !== null) return set({ walk: null });
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

// 侧栏开合的来路很多（顶栏按钮、面板上的 ×、Esc、⌘I），统一在这里记，不用每条路各写一遍
useAppStore.subscribe((state, prev) => {
  if (state.treeOpen !== prev.treeOpen) writePref(PREF.treeOpen, state.treeOpen ? "on" : "off");
  if (state.panelTab !== prev.panelTab) writePref(PREF.panelTab, state.panelTab);
  if (state.chatOpen !== prev.chatOpen) writePref(PREF.chatOpen, state.chatOpen ? "on" : "off");
});

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
