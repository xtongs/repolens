import type { RepoEntry, RepoStatus } from "@repolens/core/types";
import { useEffect, useRef, useState } from "react";
import { useAppStore } from "../store/useAppStore";

const STATUS_HINT: Record<Exclude<RepoStatus, "ok">, string> = {
  "index-missing": "索引已被删除，需要重新扫描",
  "root-missing": "目录已不存在",
};

/**
 * 仓库选择器。
 *
 * 顶栏原本只把仓库名当标题显示。做成下拉的前提是「确实有得选」——
 * 只有一个仓库时它退化成纯文字，不画箭头也不响应点击。一个点开只有
 * 自己的下拉，比没有下拉更让人困惑。
 *
 * 能选的范围是本机扫过的仓库（`~/.repolens/repos.json`）。想加新仓库要先
 * 在命令行 `repolens scan <路径>`：扫描是个写操作，而让 HTTP 端点去索引
 * 任意路径，等于把机器上任意文件的读权限交给任何能连上这个端口的东西。
 */
export function RepoPicker() {
  const repos = useAppStore((s) => s.repos);
  const repoId = useAppStore((s) => s.repoId);
  const overview = useAppStore((s) => s.overview);
  const open = useAppStore((s) => s.repoPickerOpen);
  const setOpen = useAppStore((s) => s.setRepoPickerOpen);

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

  // 扫描时仓库名来自索引，比清单里的目录名更准（monorepo 的包名可能
  // 和目录名不同），所以优先用它
  const label = overview?.repoName ?? repos.find((r) => r.id === repoId)?.name ?? "RepoLens";

  if (repos.length <= 1) {
    return <span className="truncate text-[13px] font-semibold">{label}</span>;
  }

  return (
    <div ref={boxRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex max-w-[220px] items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-semibold transition-colors hover:bg-[var(--color-surface-3)]"
        title="切换仓库"
      >
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[9px] text-[var(--color-ink-faint)]">▾</span>
      </button>

      {open && (
        <div className="anim-fade absolute left-0 top-full z-50 mt-1 w-[340px] overflow-hidden rounded-lg border border-[var(--color-line)] bg-[var(--color-surface-2)] shadow-xl">
          <div className="max-h-[60vh] overflow-y-auto py-1">
            {repos.map((repo) => (
              <RepoRow key={repo.id} repo={repo} active={repo.id === repoId} />
            ))}
          </div>

          <div className="border-t border-[var(--color-line)] px-3 py-2 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
            要加入新仓库，先在命令行运行{" "}
            <code className="mono text-[var(--color-ink-muted)]">repolens scan &lt;路径&gt;</code>
          </div>
        </div>
      )}
    </div>
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
