import type { LensKind, LensValueDto } from "@repolens/core/types";
import { create } from "zustand";
import { api } from "../api/client";
import { useAppStore } from "./useAppStore";
import { useUnderstandingStore } from "./useUnderstandingStore";

/** 服务端一次最多算这么多个节点 */
const BATCH = 150;

interface LensState {
  /** 下面这些值是按哪个视角取的 */
  kind: LensKind | null;
  values: Record<string, LensValueDto>;
  /** 已取到的节点里近 90 天提交最多的，热度按它归一 */
  maxRecent: number;
  /** 缓存清空时递增：画布据此把眼前的节点重新取一遍 */
  revision: number;
  ensure: (kind: LensKind, ids: readonly string[]) => Promise<void>;
}

let generation = 0;
const pending = new Set<string>();

export const useLensStore = create<LensState>((set, get) => ({
  kind: null,
  values: {},
  maxRecent: 0,
  revision: 0,

  async ensure(kind, ids) {
    if (get().kind !== kind) reset(kind);
    const missing = ids.filter((id) => !(id in get().values) && !pending.has(id));
    if (missing.length === 0) return;
    const current = generation;
    for (const id of missing) pending.add(id);
    try {
      for (let offset = 0; offset < missing.length; offset += BATCH) {
        const batch = missing.slice(offset, offset + BATCH);
        const values = await api.lens(kind, batch);
        if (current !== generation) return;
        const filled = Object.fromEntries(batch.map((id) => [id, values[id] ?? {}]));
        set((state) => {
          const merged = { ...state.values, ...filled };
          const maxRecent = Math.max(state.maxRecent, ...Object.values(filled).map((value) => value.recent ?? 0));
          return { values: merged, maxRecent };
        });
      }
    } catch {
      // 视角只是叠加层，取不到就不画
    } finally {
      for (const id of missing) pending.delete(id);
    }
  },
}));

function reset(kind: LensKind | null): void {
  generation++;
  pending.clear();
  useLensStore.setState((state) => ({ kind, values: {}, maxRecent: 0, revision: state.revision + 1 }));
}

useAppStore.subscribe((state, previous) => {
  if (
    state.repoId !== previous.repoId ||
    state.repoRevision !== previous.repoRevision ||
    state.indexRevision !== previous.indexRevision ||
    state.lens !== previous.lens
  ) {
    reset(state.lens);
  }
});

useUnderstandingStore.subscribe((state, previous) => {
  if (state.version !== previous.version && useLensStore.getState().kind === "understanding") reset("understanding");
});
