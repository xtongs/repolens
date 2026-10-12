import type { ChangeReportDto, GraphNodeDto } from "@repolens/core/types";
import { create } from "zustand";
import { api } from "../api/client";
import { readPref, writePref } from "../lib/prefs";
import { useAppStore } from "./useAppStore";

const BASE_PREF = "repolens:changes-base";

export type ChangeMark = "added" | "modified";

interface ChangeIndex {
  /** 文件与符号节点 id → 变化类型 */
  byId: Map<string, ChangeMark>;
  /** 新增、修改、移动后的文件；目录和包节点按前缀数 */
  files: Array<{ path: string; source: boolean }>;
}

interface ChangesState {
  base: string;
  report: ChangeReportDto | null;
  index: ChangeIndex | null;
  status: "idle" | "loading" | "ready" | "error";
  /** 正在把工作区的改动收进索引 */
  rescanning: boolean;
  error: string | null;
  compare: (base?: string) => Promise<void>;
  /** 先做一次只刷新结构的增量扫描，再对比：不开 watch 时看到的也是此刻的代码 */
  rescanAndCompare: () => Promise<void>;
}

/** 换仓库或重扫时递增：节点 id 会变，旧报告里的 id 对不上新图 */
let generation = 0;
/** 每次对比递增：索引刷新会触发新的对比，先发出去的旧对比晚回来时不能盖掉新的 */
let sequence = 0;
let inflight: Promise<void> | null = null;

export const useChangesStore = create<ChangesState>((set, get) => ({
  base: readPref(BASE_PREF) || "HEAD",
  report: null,
  index: null,
  status: "idle",
  rescanning: false,
  error: null,

  compare(base) {
    const ref = (base ?? get().base).trim() || "HEAD";
    const current = generation;
    const seq = ++sequence;
    writePref(BASE_PREF, ref === "HEAD" ? null : ref);
    set({ base: ref, status: "loading", error: null });
    const run = (async () => {
      try {
        const report = await api.changes(ref);
        if (current === generation && seq === sequence) set({ report, index: buildIndex(report), status: "ready" });
      } catch (err) {
        if (current === generation && seq === sequence) set({ status: "error", error: (err as Error).message });
      }
    })();
    inflight = run;
    void run.finally(() => {
      if (inflight === run) inflight = null;
    });
    return run;
  },

  async rescanAndCompare() {
    const repoId = useAppStore.getState().repoId;
    const current = generation;
    if (repoId !== null) {
      set({ rescanning: true, error: null });
      try {
        const { refreshedAt } = await api.refreshIndex(repoId);
        // 已经有报告时，索引刷新会自己触发一次对比（见下面的订阅），等它就行
        await useAppStore.getState().refreshIndex(refreshedAt);
      } catch (err) {
        if (current === generation) set({ status: "error", error: (err as Error).message });
        return;
      } finally {
        if (current === generation) set({ rescanning: false });
      }
    }
    if (current === generation) await (inflight ?? get().compare());
  },
}));

useAppStore.subscribe((state, previous) => {
  if (state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision) {
    generation++;
    useChangesStore.setState({ report: null, index: null, status: "idle", rescanning: false, error: null });
    return;
  }
  // watch 或手动刷新把改动收进了索引：开着的报告跟着重算，变更页成了一块实时监视屏
  if (state.indexRevision !== previous.indexRevision && useChangesStore.getState().report !== null) {
    void useChangesStore.getState().compare();
  }
});

function buildIndex(report: ChangeReportDto): ChangeIndex {
  const byId = new Map<string, ChangeMark>();
  const files: ChangeIndex["files"] = [];
  for (const file of report.files) {
    if (file.id === null) continue;
    byId.set(file.id, file.status === "added" ? "added" : "modified");
    files.push({ path: file.path, source: file.role === "source" });
  }
  for (const symbol of report.symbols) {
    if (symbol.id !== null) byId.set(symbol.id, symbol.status === "added" ? "added" : "modified");
  }
  return { byId, files };
}

/**
 * 图节点上的变更标记：文件和符号直接查表；目录和包数下面改过的文件，
 * 这样在最顶层就能看出这次改动落在哪几块。
 */
export function changeMarkOf(
  index: ChangeIndex | null,
  dto: GraphNodeDto,
  showNoise: boolean,
): { mark: ChangeMark; count: number } | null {
  if (index === null) return null;
  const direct = index.byId.get(dto.id);
  if (direct) return { mark: direct, count: 1 };
  if (dto.kind !== "directory" && dto.kind !== "package") return null;
  const dir = dto.path ?? "";
  const all = dir === "" || dir === ".";
  const count = index.files.filter(
    (file) => (showNoise || file.source) && (all || file.path.startsWith(`${dir}/`)),
  ).length;
  return count > 0 ? { mark: "modified", count } : null;
}
