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
  error: string | null;
  compare: (base?: string) => Promise<void>;
}

/** 换仓库或重扫时递增：节点 id 会变，旧报告里的 id 对不上新图 */
let generation = 0;

export const useChangesStore = create<ChangesState>((set, get) => ({
  base: readPref(BASE_PREF) || "HEAD",
  report: null,
  index: null,
  status: "idle",
  error: null,

  async compare(base) {
    const ref = (base ?? get().base).trim() || "HEAD";
    const current = generation;
    writePref(BASE_PREF, ref === "HEAD" ? null : ref);
    set({ base: ref, status: "loading", error: null });
    try {
      const report = await api.changes(ref);
      if (current === generation) set({ report, index: buildIndex(report), status: "ready" });
    } catch (err) {
      if (current === generation) set({ status: "error", error: (err as Error).message });
    }
  },
}));

useAppStore.subscribe((state, previous) => {
  if (state.repoId !== previous.repoId || state.repoRevision !== previous.repoRevision) {
    generation++;
    useChangesStore.setState({ report: null, index: null, status: "idle", error: null });
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

/** 顶栏的改动文件数，和变更页签的摘要一样跟着「噪音」开关 */
export function changedFileCount(index: ChangeIndex | null, showNoise: boolean): number {
  if (index === null) return 0;
  return showNoise ? index.files.length : index.files.filter((file) => file.source).length;
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
