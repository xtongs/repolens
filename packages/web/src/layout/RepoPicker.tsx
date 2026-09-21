import type { RepoEntry, RepoScanTaskDto, RepoStatus, ScanPhase } from "@repolens/core/types";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { useAppStore } from "../store/useAppStore";

const STATUS_HINT: Record<Exclude<RepoStatus, "ok">, string> = {
  "index-missing": "索引已被删除，需要重新扫描",
  "root-missing": "目录已不存在",
};

const PHASE_LABELS: Record<ScanPhase, string> = {
  discover: "发现文件",
  parse: "解析语法",
  resolve: "解析依赖",
  link: "链接图谱",
  rollup: "聚合指标",
  enrich: "生成 AI 语义",
  index: "建立索引",
};

/**
 * 仓库选择器。
 *
 * 单仓库时也保留下拉入口，因为添加仓库和扫描进度都放在这里。目录路径
 * 不由网页填写，而由本机服务唤起系统目录选择器，避免开放任意路径读取。
 */
export function RepoPicker() {
  const repos = useAppStore((s) => s.repos);
  const repoId = useAppStore((s) => s.repoId);
  const overview = useAppStore((s) => s.overview);
  const open = useAppStore((s) => s.repoPickerOpen);
  const setOpen = useAppStore((s) => s.setRepoPickerOpen);
  const refreshRepos = useAppStore((s) => s.refreshRepos);
  const switchRepo = useAppStore((s) => s.switchRepo);
  const [scanTask, setScanTask] = useState<RepoScanTaskDto | null>(null);
  const [picking, setPicking] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const completedRef = useRef<string | null>(null);

  const boxRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭。挂在 document 上并用 capture，否则点到画布时
  // React Flow 会先把事件吃掉，下拉就关不上了。
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open, setOpen]);

  const finishScan = useCallback(
    async (task: RepoScanTaskDto) => {
      if (!task.repo || completedRef.current === task.id) return;
      completedRef.current = task.id;
      try {
        await refreshRepos();
        setOpen(false);
        await switchRepo(task.repo.id);
      } catch (err) {
        completedRef.current = null;
        setScanError(`仓库已扫描，但打开失败：${(err as Error).message}`);
      }
    },
    [refreshRepos, setOpen, switchRepo],
  );

  // 页面刷新或菜单关闭后任务仍在服务端继续。重新挂载时恢复尚未完成的任务，
  // 避免界面看起来像扫描凭空消失。
  useEffect(() => {
    let disposed = false;
    void api.repoScans().then(({ tasks }) => {
      if (disposed) return;
      const running = tasks.find((task) => task.status === "running");
      if (running) setScanTask(running);
    }).catch(() => {
      // 恢复状态是增强能力，不影响正常浏览。
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (scanTask?.status !== "running") return;
    let disposed = false;
    let polling = false;
    const poll = () => {
      if (polling) return;
      polling = true;
      void api.repoScan(scanTask.id).then((next) => {
        if (disposed) return;
        setScanTask(next);
        if (next.status === "completed") void finishScan(next);
        if (next.status === "failed") setScanError(next.error ?? "扫描失败");
      }).catch((err: Error) => {
        if (!disposed) setScanError(`无法读取扫描进度：${err.message}`);
      }).finally(() => {
        polling = false;
      });
    };
    void poll();
    const timer = window.setInterval(poll, 500);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [finishScan, scanTask?.id, scanTask?.status]);

  const addRepository = async () => {
    setPicking(true);
    setScanError(null);
    try {
      const result = await api.pickAndScanRepo();
      if (result.cancelled || !result.task) return;
      completedRef.current = null;
      setScanTask(result.task);
      if (result.task.status === "completed") await finishScan(result.task);
      if (result.task.status === "failed") setScanError(result.task.error ?? "扫描失败");
    } catch (err) {
      setScanError((err as Error).message);
    } finally {
      setPicking(false);
    }
  };

  // 扫描时仓库名来自索引，比清单里的目录名更准（monorepo 的包名可能
  // 和目录名不同），所以优先用它
  const label = overview?.repoName ?? repos.find((r) => r.id === repoId)?.name ?? "RepoLens";

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex max-w-[220px] items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-semibold transition-colors hover:bg-[var(--color-surface-3)]"
        title="切换或添加仓库"
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[9px] text-[var(--color-ink-faint)]">▾</span>
      </button>

      {open && (
        <div className="anim-fade absolute left-0 top-full z-50 mt-1 w-[360px] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] shadow-xl">
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {repos.map((repo) => (
              <RepoRow key={repo.id} repo={repo} active={repo.id === repoId} />
            ))}
          </div>

          <div className="border-t border-[var(--color-line)] p-2">
            {scanTask && <ScanProgress task={scanTask} />}
            {scanError && (
              <div
                className="mb-2 rounded-md border border-[var(--color-danger)]/30 bg-[var(--color-danger)]/5 px-2.5 py-2 text-[10px] leading-relaxed text-[var(--color-danger)]"
                role="alert"
              >
                {scanError}
              </div>
            )}
            <button
              type="button"
              disabled={picking || scanTask?.status === "running"}
              onClick={() => void addRepository()}
              className="flex w-full items-center justify-center gap-1.5 rounded-md border border-[var(--color-line)] px-3 py-2 text-[11px] font-medium text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <FolderPlusIcon />
              {picking
                ? "等待选择目录…"
                : scanTask?.status === "running"
                  ? "正在扫描仓库…"
                  : "添加本地仓库"}
            </button>
            <p className="mt-1.5 px-1 text-[9.5px] leading-relaxed text-[var(--color-ink-faint)]">
              选择代码目录后会自动建立索引；扫描只在本机进行。
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function ScanProgress({ task }: { task: RepoScanTaskDto }) {
  const percent = Math.round(task.progress * 100);
  const phase = task.phase ? PHASE_LABELS[task.phase] : "准备扫描";
  const count = task.total > 1 ? `${task.done.toLocaleString()} / ${task.total.toLocaleString()}` : null;

  return (
    <div className="mb-2 rounded-md bg-[var(--color-surface-3)] px-2.5 py-2" aria-live="polite">
      <div className="flex items-center justify-between gap-3">
        <span className="min-w-0 truncate text-[11px] font-medium">
          {task.status === "completed" ? "扫描完成" : task.status === "failed" ? "扫描失败" : `正在扫描 ${task.name}`}
        </span>
        <span className="mono shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">
          {task.status === "completed" ? "100%" : `${percent}%`}
        </span>
      </div>
      <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-[var(--color-surface)]">
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${
            task.status === "failed" ? "bg-[var(--color-danger)]" : "bg-[var(--color-accent)]"
          }`}
          style={{ width: `${percent}%` }}
        />
      </div>
      <div className="mt-1.5 flex justify-between gap-3 text-[9.5px] text-[var(--color-ink-faint)]">
        <span>{phase}</span>
        {count && <span className="mono tabular-nums">{count}</span>}
      </div>
    </div>
  );
}

function FolderPlusIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="block h-3.5 w-3.5"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M1.75 4.5h4l1.2 1.35h7.3v6.4a1 1 0 0 1-1 1H2.75a1 1 0 0 1-1-1V4.5Z" />
      <path d="M8 8v3M6.5 9.5h3" />
    </svg>
  );
}

function RepoRow({ repo, active }: { repo: RepoEntry; active: boolean }) {
  const switchRepo = useAppStore((s) => s.switchRepo);
  const forget = useAppStore((s) => s.forgetRepo);
  const setOpen = useAppStore((s) => s.setRepoPickerOpen);
  const [error, setError] = useState<string | null>(null);

  const usable = repo.status === "ok";

  return (
    <div
      className={`group flex items-center gap-2 px-2 py-1.5 ${
        usable ? "hover:bg-[var(--color-surface-3)]" : ""
      }`}
    >
      <button
        type="button"
        disabled={!usable}
        onClick={() => {
          setOpen(false);
          void switchRepo(repo.id);
        }}
        className={`flex min-w-0 flex-1 flex-col items-start text-left ${
          usable ? "" : "cursor-not-allowed opacity-45"
        }`}
        title={usable ? repo.root : STATUS_HINT[repo.status as Exclude<RepoStatus, "ok">]}
      >
        <span className="flex w-full items-center gap-1.5">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{
              background: active
                ? "var(--color-accent)"
                : usable
                  ? "var(--color-line-strong)"
                  : "var(--color-danger)",
            }}
          />
          <span className="truncate text-[12px] font-medium">{repo.name}</span>
          {!usable && (
            <span className="shrink-0 text-[10px] text-[var(--color-danger)]">
              {STATUS_HINT[repo.status as Exclude<RepoStatus, "ok">]}
            </span>
          )}
        </span>
        <span className="mono w-full truncate pl-3 text-[10px] text-[var(--color-ink-faint)]">
          {shorten(repo.root)}
        </span>
      </button>

      {/*
        移除只动清单，不动仓库和索引，所以不需要二次确认——
        代价是重新 scan 一次，而误删的唯一后果是从这个列表里消失。
      */}
      {!active && (
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            setError(null);
            void forget(repo.id).catch((err: Error) => setError(err.message));
          }}
          className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-ink-faint)] opacity-0 transition-opacity hover:text-[var(--color-danger)] group-hover:opacity-100"
          title="从清单移除（不删除仓库和索引）"
        >
          移除
        </button>
      )}

      {error !== null && <span className="text-[10px] text-[var(--color-danger)]">{error}</span>}
    </div>
  );
}

/**
 * 把家目录缩写成 `~`。
 *
 * 前端拿不到 $HOME，但仓库路径几乎都在家目录下，`/Users/<名字>/` 这一段
 * 对每一行都一样，纯属挤掉真正有区别的后半截。按平台惯例反推前两段即可。
 */
function shorten(path: string): string {
  const match = /^(\/(?:Users|home)\/[^/]+)(\/.*)?$/.exec(path);
  return match ? `~${match[2] ?? ""}` : path;
}
