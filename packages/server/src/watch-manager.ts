import { indexChangeFilter } from "@repolens/core";
import { watch, type FSWatcher } from "node:fs";
import type { ScanManager } from "./scan-manager.js";

/** 连续保存、AI 一口气改十几个文件时，等这么久没有新改动再刷新一次 */
const DEBOUNCE_MS = 700;

export interface WatchStatus {
  enabled: boolean;
  /** 正在把改动收进索引 */
  refreshing: boolean;
  /** 上次刷新完成的时间 */
  refreshedAt: string | null;
  /** 上次刷新失败的原因 */
  error: string | null;
}

export type WatchEvent =
  | { type: "status"; status: WatchStatus }
  /** 索引已经按最新的文件刷新过，界面该重新取数了 */
  | { type: "index"; refreshedAt: string };

interface Watched {
  root: string;
  watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  status: WatchStatus;
}

/**
 * 盯着仓库目录，文件一变就做一次只刷新结构的增量扫描，然后通知界面。
 *
 * AI 在旁边改代码时，人不用手动重扫就能看到图、体检和变更页跟着变：变更页以会话开始时的
 * 提交为基线实时更新，等于一块「AI 这次改了什么结构」的监视屏。忽略规则和扫描时一致，
 * .git、.repolens、node_modules 这类目录里的变化不触发刷新。
 */
export class WatchManager {
  private readonly watched = new Map<string, Watched>();

  constructor(
    private readonly scans: ScanManager,
    private readonly notify: (repoId: string, event: WatchEvent) => void,
  ) {}

  status(repoId: string): WatchStatus {
    return this.watched.get(repoId)?.status ?? { enabled: false, refreshing: false, refreshedAt: null, error: null };
  }

  start(repoId: string, root: string): WatchStatus {
    const existing = this.watched.get(repoId);
    if (existing) return existing.status;
    const relevant = indexChangeFilter(root);

    const watcher = watch(root, { recursive: true, persistent: false }, (_event, file) => {
      if (!relevant(typeof file === "string" ? file : null)) return;
      const entry = this.watched.get(repoId);
      if (!entry) return;
      if (entry.timer) clearTimeout(entry.timer);
      entry.timer = setTimeout(() => void this.refresh(repoId), DEBOUNCE_MS);
    });
    watcher.on("error", (err) => {
      const entry = this.watched.get(repoId);
      if (!entry) return;
      entry.status = { ...entry.status, error: err.message };
      this.notify(repoId, { type: "status", status: entry.status });
    });

    const entry: Watched = { root, watcher, timer: null, status: { enabled: true, refreshing: false, refreshedAt: null, error: null } };
    this.watched.set(repoId, entry);
    this.notify(repoId, { type: "status", status: entry.status });
    return entry.status;
  }

  stop(repoId: string): WatchStatus {
    const entry = this.watched.get(repoId);
    if (entry) {
      if (entry.timer) clearTimeout(entry.timer);
      entry.watcher.close();
      this.watched.delete(repoId);
    }
    const status = this.status(repoId);
    this.notify(repoId, { type: "status", status });
    return status;
  }

  close(): void {
    for (const repoId of [...this.watched.keys()]) this.stop(repoId);
  }

  private async refresh(repoId: string): Promise<void> {
    const entry = this.watched.get(repoId);
    if (!entry) return;
    entry.timer = null;
    entry.status = { ...entry.status, refreshing: true, error: null };
    this.notify(repoId, { type: "status", status: entry.status });
    try {
      await this.scans.refresh(entry.root);
      const refreshedAt = new Date().toISOString();
      entry.status = { ...entry.status, refreshing: false, refreshedAt };
      this.notify(repoId, { type: "index", refreshedAt });
    } catch (err) {
      entry.status = { ...entry.status, refreshing: false, error: (err as Error).message };
    }
    if (this.watched.get(repoId) === entry) this.notify(repoId, { type: "status", status: entry.status });
  }
}
