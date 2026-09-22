import type { FindingSummaryDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { METRIC_LABELS } from "../lib/visual";
import { useAppStore, type MetricKey } from "../store/useAppStore";
import { RepoPicker } from "./RepoPicker";

const METRICS: MetricKey[] = ["loc", "complexity", "symbols"];

/**
 * 顶栏。
 *
 * 「删除」策略在这里最吃紧：能放的东西太多了。最终只保留三类——
 * 我在哪（仓库名 + 面包屑）、看什么（指标）、看多少（噪音开关），
 * 其余全部进 ⌘K 或过滤抽屉。
 */
export function TopBar() {
  const store = useAppStore();
  const overview = store.overview;

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3">
      <button
        type="button"
        onClick={() => store.setTreeOpen(!store.treeOpen)}
        className={`flex h-7 w-7 items-center justify-center rounded-md border text-[13px] transition-colors ${
          store.treeOpen
            ? "border-[var(--color-accent)] text-[var(--color-accent)]"
            : "border-[var(--color-line)] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)]"
        }`}
        title="结构树"
      >
        <SidebarIcon />
      </button>

      <FindingsPill />
      <TracePill />
      <LlmPill />

      <div className="flex min-w-0 items-baseline gap-2">
        <RepoPicker />
        {overview && (
          <span className="hidden shrink-0 text-[11px] text-[var(--color-ink-faint)] sm:inline">
            {overview.totals.loc.toLocaleString("en-US")} 行 ·{" "}
            {overview.packages.length > 1 ? `${overview.packages.length} 个包` : "单包"} ·{" "}
            {overview.languages
              .slice(0, 3)
              .map((l) => l.language)
              .join(" / ")}
          </span>
        )}
      </div>

      <Breadcrumb />

      {/*
        调用图模式下换掉整组控件而不是往后追加。指标、噪音、外部依赖
        在一张函数调用图上都无从谈起，留着它们只是让人误以为能用。
      */}
      <div className="ml-auto flex items-center gap-1.5">
        {store.traceId ? <TraceControls /> : store.callGraph ? <CallGraphControls /> : <StructureControls />}

        <button
          type="button"
          onClick={() => store.setPaletteOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
        >
          搜索
          <kbd className="mono rounded bg-[var(--color-surface-3)] px-1 text-[10px]">⌘K</kbd>
        </button>

        <FontSizeControl />
        <ThemeToggle />

        <button
          type="button"
          onClick={() => store.setHelpOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-line)] text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
          title="手势说明"
        >
          ?
        </button>
      </div>
    </header>
  );
}

function SidebarIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="block h-3.5 w-3.5"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M2.5 4h11M2.5 8h11M2.5 12h11" />
    </svg>
  );
}

type Theme = "dark" | "light";
const THEME_STORAGE_KEY = "repolens-theme";
type FontSize = "small" | "medium" | "large";
const FONT_SIZE_STORAGE_KEY = "repolens-font-size";
const FONT_SIZES: ReadonlyArray<{ key: FontSize; label: string }> = [
  { key: "small", label: "100%" },
  { key: "medium", label: "115%" },
  { key: "large", label: "130%" },
];

function FontSizeControl() {
  const [fontSize, setFontSize] = useState<FontSize>(() => {
    const current = document.documentElement.dataset["fontSize"];
    return current === "small" || current === "large" ? current : "medium";
  });
  const index = FONT_SIZES.findIndex((option) => option.key === fontSize);
  const current = FONT_SIZES[index] ?? FONT_SIZES[1];

  const apply = (nextIndex: number) => {
    const next = FONT_SIZES[nextIndex];
    if (!next) return;
    document.documentElement.dataset.fontSize = next.key;
    try {
      localStorage.setItem(FONT_SIZE_STORAGE_KEY, next.key);
    } catch {
      // 浏览器禁用存储时，本次调节仍然有效。
    }
    setFontSize(next.key);
  };

  return (
    <div
      className="flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--color-line)]"
      role="group"
      aria-label="字体大小"
    >
      <button
        type="button"
        disabled={index === 0}
        onClick={() => apply(index - 1)}
        className="flex w-7 items-center justify-center text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-35"
        title="缩小字体"
        aria-label="缩小字体"
      >
        A−
      </button>
      <span
        className="mono flex min-w-10 items-center justify-center border-x border-[var(--color-line)] bg-[var(--color-surface-2)] px-1 text-[9px] tabular-nums text-[var(--color-ink-faint)]"
        aria-live="polite"
      >
        {current?.label}
      </span>
      <button
        type="button"
        disabled={index === FONT_SIZES.length - 1}
        onClick={() => apply(index + 1)}
        className="flex w-7 items-center justify-center text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-35"
        title="放大字体"
        aria-label="放大字体"
      >
        A+
      </button>
    </div>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset["theme"] === "light" ? "light" : "dark",
  );
  const target = theme === "dark" ? "light" : "dark";
  const label = target === "light" ? "切换到浅色模式" : "切换到深色模式";

  const toggle = () => {
    const next = target;
    const root = document.documentElement;
    root.dataset["theme"] = next;
    root.classList.toggle("dark", next === "dark");
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      next === "light" ? "#f3f5f8" : "#0b0d10",
    );
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // 浏览器禁用存储时，本次切换仍然有效。
    }
    setTheme(next);
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-line)] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
      title={label}
      aria-label={label}
      aria-pressed={theme === "light"}
    >
      {theme === "dark" ? <SunIcon /> : <MoonIcon />}
    </button>
  );
}

function SunIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M18.7 5.3l-1.4 1.4M6.7 17.3l-1.4 1.4" />
    </svg>
  );
}

function MoonIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 15.2A8 8 0 0 1 8.8 4a8 8 0 1 0 11.2 11.2Z" />
    </svg>
  );
}

function LlmPill() {
  const overview = useAppStore((s) => s.overview);
  const llm = overview?.llm;
  if (!llm) return null;
  const ready = llm.enabled && llm.available;
  return (
    <span
      className={`rounded-full border px-1.5 py-0.5 text-[9.5px] ${
        ready
          ? "border-[var(--color-accent)]/40 text-[var(--color-accent)]"
          : "border-[var(--color-line)] text-[var(--color-ink-faint)]"
      }`}
      title={
        ready
          ? `${llm.model}${llm.interactiveModel ? ` / 交互 ${llm.interactiveModel}` : ""} · 累计 ${llm.usage.totalTokens.toLocaleString()} tokens`
          : (llm.reason ?? "纯结构模式")
      }
    >
      AI {ready ? "已就绪" : "未启用"}
    </span>
  );
}

function StructureControls() {
  const store = useAppStore();
  return (
    <>
      <div className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
        {METRICS.map((metric) => (
          <button
            key={metric}
            type="button"
            onClick={() => store.setMetric(metric)}
            className={`px-2.5 py-1 text-[11px] transition-colors ${
              store.metric === metric
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {METRIC_LABELS[metric]}
          </button>
        ))}
      </div>

      <Toggle
        active={store.showNoise}
        onClick={() => store.setShowNoise(!store.showNoise)}
        title="显示测试、配置、生成代码等非主干文件"
      >
        噪音
      </Toggle>

      <Toggle
        active={store.showExternal}
        onClick={() => store.setShowExternal(!store.showExternal)}
        title="把对第三方依赖的引用聚合成一个节点显示"
      >
        外部依赖
      </Toggle>
    </>
  );
}

const DIRECTIONS = [
  { key: "callers", label: "调用方" },
  { key: "callees", label: "被调" },
  { key: "both", label: "双向" },
] as const;

function CallGraphControls() {
  const store = useAppStore();
  const mode = store.callGraph;
  if (!mode) return null;

  const showAmbiguous = store.confidence.includes("ambiguous");
  const omitted = store.subgraphs[mode.scopeId]?.truncated ?? 0;

  return (
    <>
      <div className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
        {DIRECTIONS.map((dir) => (
          <button
            key={dir.key}
            type="button"
            onClick={() => void store.setCallDirection(dir.key)}
            className={`px-2.5 py-1 text-[11px] transition-colors ${
              mode.direction === dir.key
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {dir.label}
          </button>
        ))}
      </div>

      <div className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
        {[1, 2, 3].map((depth) => (
          <button
            key={depth}
            type="button"
            onClick={() => void store.setCallDepth(depth)}
            title={`向外展开 ${depth} 跳`}
            className={`px-2 py-1 text-[11px] tabular-nums transition-colors ${
              mode.depth === depth
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {depth}跳
          </button>
        ))}
      </div>

      <Toggle
        active={showAmbiguous}
        onClick={() =>
          void store.setConfidence(
            showAmbiguous ? ["exact", "likely"] : ["exact", "likely", "ambiguous"],
          )
        }
        title="同名候选不止一个的调用。默认隐藏，因为无法确定真正指向哪一个"
      >
        多义边
      </Toggle>

      {/*
        截断必须说出来。热点函数有上百个调用方，画面上只画得下十几个，
        不标注的话这张图看起来就像「它只被这些地方调用」。
      */}
      {omitted > 0 && (
        <span
          className="text-[11px] text-[var(--color-warn)]"
          title="按调用次数取前若干条。完整列表在右侧详情的「关系」标签页"
        >
          另有 {omitted} 条未画
        </span>
      )}
    </>
  );
}

function TraceControls() {
  const close = useAppStore((s) => s.closeTrace);
  return (
    <button type="button" onClick={close}
      className="rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)]">
      返回结构图
    </button>
  );
}

/** 面包屑只在有聚焦或展开时出现，默认视图下它是纯噪音 */
function Breadcrumb() {
  const store = useAppStore();
  const parts: Array<{ label: string; onClick: () => void }> = [];

  if (store.callGraph) {
    parts.push({
      label: `调用图 ${store.callGraph.label}`,
      onClick: () => store.closeCallGraph(),
    });
  }
  if (store.traceId) {
    parts.push({ label: `链路 ${store.traceLabel ?? store.traceId}`, onClick: () => store.closeTrace() });
  }
  if (store.focus !== null) {
    parts.push({ label: `聚焦 ${labelOf(store.focus)}`, onClick: () => store.setFocus(null) });
  }
  // 展开层数属于结构视图的状态，调用图模式下它既不可见也不可操作，
  // 显示出来只会让人以为面包屑描述的是眼前这张图
  if (store.expanded.length > 0 && !store.callGraph) {
    parts.push({
      label: `已展开 ${store.expanded.length} 层`,
      onClick: () => useAppStore.setState({ expanded: [] }),
    });
  }
  if (store.hiddenNodes.length > 0) {
    parts.push({ label: `已隐藏 ${store.hiddenNodes.length} 项`, onClick: () => store.resetHidden() });
  }

  if (parts.length === 0) return null;

  return (
    <div className="anim-fade flex items-center gap-1.5">
      {parts.map((part) => (
        <button
          key={part.label}
          type="button"
          onClick={part.onClick}
          className="group flex items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface-2)] py-0.5 pl-2.5 pr-1.5 text-[11px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)]"
        >
          {part.label}
          <span className="text-[var(--color-ink-faint)] group-hover:text-[var(--color-ink)]">×</span>
        </button>
      ))}
    </div>
  );
}

function TracePill() {
  const store = useAppStore();
  const open = store.treeOpen && store.panelTab === "traces";
  return (
    <button type="button" onClick={() => { store.setPanelTab("traces"); store.setTreeOpen(!open); }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
      style={{ borderColor: open ? "var(--color-accent)" : "var(--color-line)", color: open ? "var(--color-accent)" : "var(--color-ink-muted)" }}
      title="入口到 I/O 边界的关键链路">
      ⇢ 链路
    </button>
  );
}

function labelOf(nodeId: string): string {
  const colon = nodeId.indexOf(":");
  const rest = colon >= 0 ? nodeId.slice(colon + 1) : nodeId;
  const slash = rest.lastIndexOf("/");
  return slash >= 0 ? rest.slice(slash + 1) : rest;
}

function Toggle({
  active,
  onClick,
  title,
  children,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`rounded-md border px-2.5 py-1 text-[11px] transition-colors ${
        active
          ? "border-[var(--color-accent)] text-[var(--color-accent)]"
          : "border-[var(--color-line)] text-[var(--color-ink-faint)] hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

/**
 * 体检入口。
 *
 * 只在真有问题时出现——没有问题时不该占位置，更不该显示一个「0」让人
 * 反复确认。这是「删除」策略：界面元素的存在本身就是一次对注意力的索取。
 */
function FindingsPill() {
  const [summary, setSummary] = useState<FindingSummaryDto | null>(null);
  const store = useAppStore();
  const repoId = store.repoId;
  const repoRevision = store.repoRevision;

  // 跟着仓库重取。否则换完仓库这里还挂着上一个仓库的问题数，
  // 而角标是会被当成事实去点的。
  useEffect(() => {
    let stale = false;
    setSummary(null);
    void api
      .findings()
      .then((res) => {
        if (!stale) setSummary(res.summary);
      })
      .catch(() => {
        if (!stale) setSummary(null);
      });
    return () => {
      stale = true;
    };
  }, [repoId, repoRevision]);

  if (!summary || summary.total === 0) return null;

  const open = store.treeOpen && store.panelTab === "findings";
  const color = summary.high > 0 ? "var(--color-danger)" : "var(--color-warn)";

  return (
    <button
      type="button"
      onClick={() => {
        store.setPanelTab("findings");
        store.setTreeOpen(!open);
      }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
      style={{
        borderColor: open ? color : "var(--color-line)",
        color: open ? color : "var(--color-ink-muted)",
      }}
      title={`架构体检：${summary.total} 处结构问题`}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      体检 {summary.total}
    </button>
  );
}
