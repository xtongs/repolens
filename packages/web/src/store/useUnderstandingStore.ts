import type { LensValueDto, UnderstandingDto, UnderstandingHow } from "@repolens/core/types";
import { create } from "zustand";
import { api } from "../api/client";
import { useAppStore } from "./useAppStore";

interface UnderstandingState {
  /** 账本全貌；入口页签打开时才取 */
  ledger: UnderstandingDto | null;
  status: "idle" | "loading" | "ready" | "error";
  error: string | null;
  /** 节点 → 它自己的标记状态。详情、走读、变更页上的「我看懂了」按钮读这里 */
  marks: Record<string, LensValueDto>;
  /** 标记变了就递增：图上的「我的理解」视角据此重取 */
  version: number;
  load: () => Promise<void>;
  /** 取这些节点的标记状态，取过的不再取 */
  track: (nodeIds: readonly string[]) => Promise<void>;
  mark: (nodeId: string, how: UnderstandingHow) => Promise<void>;
  unmark: (nodeId: string) => Promise<void>;
}

/** 换仓库、索引刷新时递增：内容指纹会变，缓存的状态对不上了 */
let generation = 0;
const pending = new Set<string>();

export const useUnderstandingStore = create<UnderstandingState>((set, get) => ({
  ledger: null,
  status: "idle",
  error: null,
  marks: {},
  version: 0,

  async load() {
    const current = generation;
    set({ status: get().ledger ? "ready" : "loading", error: null });
    try {
      const ledger = await api.understanding();
      if (current === generation) set({ ledger, status: "ready" });
    } catch (err) {
      if (current === generation) set({ status: "error", error: (err as Error).message });
    }
  },

  async track(nodeIds) {
    const missing = nodeIds.filter((id) => !(id in get().marks) && !pending.has(id));
    if (missing.length === 0) return;
    const current = generation;
    for (const id of missing) pending.add(id);
    try {
      const values = await api.lens("understanding", missing);
      if (current !== generation) return;
      // 认不出的节点也记一笔空值，免得每次渲染都再问一遍
      const filled = Object.fromEntries(missing.map((id) => [id, values[id] ?? {}]));
      set((state) => ({ marks: { ...state.marks, ...filled } }));
    } finally {
      for (const id of missing) pending.delete(id);
    }
  },

  async mark(nodeId, how) {
    await api.markUnderstood(nodeId, how);
    await afterChange(nodeId);
  },

  async unmark(nodeId) {
    const key = get().marks[nodeId]?.key;
    if (!key) return;
    await api.unmarkUnderstood(key);
    await afterChange(nodeId);
  },
}));

/**
 * 一条标记会牵动别的节点：标了文件，里面的函数都算看懂；标了函数，所在目录的占比也变了。
 * 所以清掉整个缓存，只把这一个节点立刻重取回来，其余的谁要用谁再取。
 */
async function afterChange(nodeId: string): Promise<void> {
  generation++;
  useUnderstandingStore.setState((state) => ({ marks: {}, version: state.version + 1 }));
  const { ledger } = useUnderstandingStore.getState();
  await Promise.all([
    useUnderstandingStore.getState().track([nodeId]),
    ledger ? useUnderstandingStore.getState().load() : Promise.resolve(),
  ]);
}

useAppStore.subscribe((state, previous) => {
  const repoChanged = state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision;
  if (!repoChanged && state.indexRevision === previous.indexRevision) return;
  generation++;
  useUnderstandingStore.setState((s) => ({
    marks: {},
    version: s.version + 1,
    ...(repoChanged ? { ledger: null, status: "idle" as const, error: null } : {}),
  }));
  if (!repoChanged && useUnderstandingStore.getState().ledger) void useUnderstandingStore.getState().load();
});
