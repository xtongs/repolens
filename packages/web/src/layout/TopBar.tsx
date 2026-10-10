import type { FindingSummaryDto } from "@repolens/core/types";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../api/client";
import { msg, translateMessage, useLocale, useLocaleStore, useT } from "../i18n";
import { desktop } from "../lib/desktop";
import { writePref } from "../lib/prefs";
import { modKey } from "../lib/shortcut";
import { METRIC_LABELS } from "../ui/visual";
import { useAppStore, type MetricKey } from "../store/useAppStore";
import { changedFileCount, useChangesStore } from "../store/useChangesStore";
import { useChatStore } from "../store/useChatStore";
import { RepoPicker } from "./RepoPicker";
import { measureSidebarAnchors } from "./ResizablePanelHandle";

const METRICS: MetricKey[] = ["loc", "complexity", "symbols"];

/**
 * 顶栏。
 *
 * 「删除」策略在这里最吃紧：能放的东西太多了。最终只保留三类——
 * 我在哪（仓库名 + 面包屑）、看什么（指标）、看多少（噪音开关），
 * 其余全部进 ⌘K 或过滤抽屉。
 *
 * 任何按钮都不换行。窗口变窄时先截短仓库名后面的统计行，再收起次要文字
 * （见 useCompactTopBar），最后才裁面包屑；仓库名本身始终完整。
 */
export function TopBar() {
  const t = useT();
  const store = useAppStore();
  const overview = store.overview;
  const { headerRef, slackRef } = useCompactTopBar();

  // 还没打开仓库时只留仓库选择和外观设置，其余控件都没有可作用的对象
  if (store.noRepo) {
    return (
      <header className="app-topbar flex h-12 shrink-0 items-center gap-3 whitespace-nowrap border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3">
        <RepoPicker />
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <FontSizeControl />
          <ThemeToggle />
          <LocaleToggle />
        </div>
      </header>
    );
  }

  return (
    <header
      ref={headerRef}
      className="app-topbar flex h-12 shrink-0 items-center gap-3 whitespace-nowrap border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3"
    >
      <div data-sidebar-anchor="left" className="flex shrink-0 items-center gap-3">
        <button
          type="button"
          onClick={() => store.setTreeOpen(!store.treeOpen)}
          className={`flex h-7 w-7 items-center justify-center rounded-md border text-[13px] transition-colors ${
            store.treeOpen
              ? "border-[var(--color-accent)] text-[var(--color-accent)]"
              : "border-[var(--color-line)] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)]"
          }`}
          title={t("结构树")}
        >
          <SidebarIcon />
        </button>

        <FindingsPill />
        <EntriesPill />
        <ChangesPill />
        <LlmPill />
      </div>

      {/*
        外层不能设 min-w-0：它的最小宽度就是仓库名的宽度，仓库名因此不会被挤掉。
        里层 w-0 flex-1 不向外层要最小宽度，只分剩下的空间。
      */}
      <div className="flex flex-1 items-baseline gap-2">
        <RepoPicker />
        <div ref={slackRef} className="flex w-0 flex-1 items-center gap-3 overflow-hidden">
          {overview && (
            <span data-topbar-optional="1" className="min-w-0 truncate text-[11px] text-[var(--color-ink-faint)]">
              {t("{loc} 行", { loc: overview.totals.loc.toLocaleString("en-US") })} ·{" "}
              {overview.packages.length > 1 ? t("{count} 个包", { count: overview.packages.length }) : t("单包")} ·{" "}
              {overview.languages
                .slice(0, 3)
                .map((l) => l.language)
                .join(" / ")}
            </span>
          )}

          <Breadcrumb />
        </div>
      </div>

      {/*
        调用图模式下换掉整组控件而不是往后追加。指标、噪音、外部依赖
        在一张函数调用图上都无从谈起，留着它们只是让人误以为能用。
      */}
      <div className="flex shrink-0 items-center gap-1.5">
        {store.walk ? <WalkControls /> : store.callGraph ? <CallGraphControls /> : <StructureControls />}

        <button
          type="button"
          onClick={() => store.setPaletteOpen(true)}
          className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] text-[var(--color-ink-faint)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink-muted)]"
          title={t("搜索")}
          aria-label={t("搜索")}
        >
          <span data-topbar-optional="2">{t("搜索")}</span>
          <kbd className="mono rounded bg-[var(--color-surface-3)] px-1 text-[10px]">{modKey("K")}</kbd>
        </button>

        <FontSizeControl />
        <ThemeToggle />
        <LocaleToggle />

        <button
          type="button"
          onClick={() => store.setHelpOpen(true)}
          className="flex h-7 w-7 items-center justify-center rounded-md border border-[var(--color-line)] text-[11px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
          title={t("手势说明")}
        >
          ?
        </button>
      </div>
    </header>
  );
}

const COMPACT_LEVELS = 2;

/**
 * 顶栏放不下时逐级收起次要文字，只留图标、数字和快捷键：data-compact="1" 收起
 * data-topbar-optional="1" 的，仍放不下再到 "2"，连 "2" 的也收起。
 *
 * 按实测宽度判断而不是按窗口断点：仓库名长短、体检角标在不在、界面语言、字号、
 * 桌面端给红绿灯留的位置都会改变需要的宽度。slackRef 那一格分的是剩余空间，
 * 里面的统计行可以随便截短，面包屑要完整放下——它上面的 × 是退出聚焦和调用图
 * 的唯一入口。全部收起后仍放不下时，面包屑只截文字，× 留着。
 */
function useCompactTopBar() {
  const [header, setHeader] = useState<HTMLElement | null>(null);
  const [slack, setSlack] = useState<HTMLDivElement | null>(null);
  // saved[i]：从第 i 级收到第 i+1 级省下的宽度。只能在收起前后各量一次，收起后那些元素已经不占位了
  const saved = useRef<number[]>([]);

  const fit = useCallback(() => {
    const last = header?.lastElementChild;
    if (!header || !slack || !last) return;
    const paddingRight = Number.parseFloat(getComputedStyle(header).paddingRight) || 0;
    const box = header.getBoundingClientRect();
    // 内容实际排到的宽度，扣掉剩余空间那一格，再补上面包屑本来的宽度
    const need = () =>
      last.getBoundingClientRect().right +
      paddingRight -
      box.left -
      slack.getBoundingClientRect().width +
      breadcrumbWidth(slack);

    let level = Number(header.dataset["compact"] ?? 0);
    const setLevel = (next: number) => {
      level = next;
      if (next === 0) delete header.dataset["compact"];
      else header.dataset["compact"] = String(next);
    };

    while (level < COMPACT_LEVELS) {
      const before = need();
      if (before <= box.width) break;
      setLevel(level + 1);
      saved.current[level - 1] = before - need();
    }
    // 留 8px 余量，免得在临界宽度上来回切
    while (level > 0 && need() + (saved.current[level - 1] ?? Number.POSITIVE_INFINITY) + 8 <= box.width) {
      setLevel(level - 1);
    }
    measureSidebarAnchors(header);
  }, [header, slack]);

  // 切模式、换语言、面包屑增减都会重新渲染顶栏，绘制前同步量好就不会闪一下
  useLayoutEffect(() => fit());

  // 拖窗口、改字号、体检角标加载出来都不经过顶栏渲染，靠尺寸变化触发
  useEffect(() => {
    if (!header) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(fit);
    });
    observer.observe(header);
    for (const child of header.children) observer.observe(child);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [header, fit]);

  return { headerRef: setHeader, slackRef: setSlack };
}

/** 面包屑不截字时的宽度，连同它和前面统计行之间的间距；被挤窄截掉的字补回来，但每段不超过自己的 max-width */
function breadcrumbWidth(slack: HTMLElement): number {
  const crumbs = slack.querySelector<HTMLElement>("[data-breadcrumb]");
  if (!crumbs) return 0;
  let width = crumbs.getBoundingClientRect().width;
  for (const part of crumbs.children) {
    const label = part.firstElementChild;
    if (!label) continue;
    const current = part.getBoundingClientRect().width;
    const max = Number.parseFloat(getComputedStyle(part).maxWidth) || Number.POSITIVE_INFINITY;
    width += Math.min(max, current + label.scrollWidth - label.clientWidth) - current;
  }
  const previous = crumbs.previousElementSibling;
  const gap = previous && getComputedStyle(previous).display !== "none" ? Number.parseFloat(getComputedStyle(slack).columnGap) || 0 : 0;
  return width + gap;
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
  const t = useT();
  const [fontSize, setFontSize] = useState<FontSize>(() => {
    const current = document.documentElement.dataset["fontSize"];
    return current === "medium" || current === "large" ? current : "small";
  });
  const index = FONT_SIZES.findIndex((option) => option.key === fontSize);
  const current = FONT_SIZES[index] ?? FONT_SIZES[0];

  const apply = (nextIndex: number) => {
    const next = FONT_SIZES[nextIndex];
    if (!next) return;
    document.documentElement.dataset.fontSize = next.key;
    writePref(FONT_SIZE_STORAGE_KEY, next.key);
    setFontSize(next.key);
  };

  return (
    <div
      className="flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--color-line)]"
      role="group"
      aria-label={t("字体大小")}
    >
      <button
        type="button"
        disabled={index === 0}
        onClick={() => apply(index - 1)}
        className="flex w-7 items-center justify-center text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)] disabled:cursor-not-allowed disabled:opacity-35"
        title={t("缩小字体")}
        aria-label={t("缩小字体")}
      >
        A−
      </button>
      <span
        data-topbar-optional="1"
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
        title={t("放大字体")}
        aria-label={t("放大字体")}
      >
        A+
      </button>
    </div>
  );
}

function ThemeToggle() {
  const t = useT();
  const [theme, setTheme] = useState<Theme>(() =>
    document.documentElement.dataset["theme"] === "light" ? "light" : "dark",
  );
  const target = theme === "dark" ? "light" : "dark";
  const label = target === "light" ? t("切换到浅色模式") : t("切换到深色模式");

  const toggle = () => {
    const next = target;
    const root = document.documentElement;
    root.dataset["theme"] = next;
    root.classList.toggle("dark", next === "dark");
    document.querySelector<HTMLMetaElement>('meta[name="theme-color"]')?.setAttribute(
      "content",
      next === "light" ? "#f3f5f8" : "#0b0d10",
    );
    writePref(THEME_STORAGE_KEY, next);
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

/** 两种语言并排摆着，当前那一种高亮；每一格都用它自己的语言写，看不懂另一种也找得到 */
function LocaleToggle() {
  const locale = useLocale();
  const setLocale = useLocaleStore((s) => s.setLocale);
  const options = [
    { key: "zh", label: "中", title: "切换到中文" },
    { key: "en", label: "EN", title: "Switch to English" },
  ] as const;
  // 行高取内框高度（h-7 减去上下边框）。默认 1.5 倍行高在 130% 字号下是小数，
  // 取整后字会往上偏 1px 多，高亮的那一格上下留白明显不等
  return (
    <div
      className="flex h-7 items-stretch overflow-hidden rounded-md border border-[var(--color-line)] leading-[26px]"
      role="group"
      aria-label={locale === "zh" ? "界面语言" : "Language"}
    >
      {options.map((option) => (
        <button
          key={option.key}
          type="button"
          lang={option.key === "zh" ? "zh-CN" : "en"}
          aria-pressed={locale === option.key}
          onClick={() => setLocale(option.key)}
          title={option.title}
          className={`flex min-w-7 items-center justify-center px-1.5 text-[10.5px] transition-colors ${
            locale === option.key
              ? "bg-[var(--color-surface-3)] font-medium text-[var(--color-ink)]"
              : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
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
  const t = useT();
  const overview = useAppStore((s) => s.overview);
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setChatOpen = useAppStore((s) => s.setChatOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const llm = overview?.llm;
  if (!llm) return null;
  const ready = llm.enabled && llm.available;
  const tokens = t("累计 {count} tokens", { count: llm.usage.totalTokens.toLocaleString("en-US") });
  const status = ready
    ? `${llm.model}${llm.interactiveModel ? ` / ${t("交互")} ${llm.interactiveModel}` : ""} · ${tokens}`
    : (llm.reason ? translateMessage(llm.reason) : t("纯结构模式"));
  // 桌面端能直接在界面里配好 AI，未就绪时点它先去配置，而不是打开一个答不了话的对话框
  const configure = !ready && desktop !== null;
  const state = ready ? t("已就绪 · 追问") : configure ? t("未配置 · 设置") : t("未启用 · 追问");
  return (
    <button
      type="button"
      aria-pressed={chatOpen}
      onClick={() => {
        if (configure) setSettingsOpen(true);
        else if (chatOpen) setChatOpen(false);
        else useChatStore.getState().open();
      }}
      className={`rounded-full border px-1.5 py-0.5 text-[9.5px] transition-colors ${
        ready
          ? "border-[var(--color-accent)]/40 text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10"
          : "border-[var(--color-line)] text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
      } ${chatOpen ? "bg-[var(--color-accent)]/10" : ""}`}
      title={configure ? `${status}\n${t("点击配置 AI")}` : `${status}\n${t("点击追问 AI（{shortcut}）", { shortcut: modKey("I") })}`}
    >
      AI<span data-topbar-optional="1">{` ${state}`}</span>
    </button>
  );
}

function StructureControls() {
  const t = useT();
  const store = useAppStore();
  return (
    <>
      <div data-sidebar-anchor="right" className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
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
            {t(METRIC_LABELS[metric])}
          </button>
        ))}
      </div>

      <Toggle
        active={store.showNoise}
        onClick={() => store.setShowNoise(!store.showNoise)}
        title={t("显示测试、配置、生成代码等非主干文件")}
      >
        {t("噪音")}
      </Toggle>

      <Toggle
        active={store.showExternal}
        onClick={() => store.setShowExternal(!store.showExternal)}
        title={t("把对第三方依赖的引用聚合成一个节点显示")}
      >
        {t("外部依赖")}
      </Toggle>
    </>
  );
}

const DIRECTIONS = [
  { key: "callers", label: msg("调用方") },
  { key: "callees", label: msg("被调") },
  { key: "both", label: msg("双向") },
] as const;

function CallGraphControls() {
  const t = useT();
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
            {t(dir.label)}
          </button>
        ))}
      </div>

      <div className="flex overflow-hidden rounded-md border border-[var(--color-line)]">
        {[1, 2, 3].map((depth) => (
          <button
            key={depth}
            type="button"
            onClick={() => void store.setCallDepth(depth)}
            title={t("向外展开 {count} 跳", { count: depth })}
            className={`px-2 py-1 text-[11px] tabular-nums transition-colors ${
              mode.depth === depth
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {depth}
            <span data-topbar-optional="1">{t("跳", { count: depth })}</span>
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
        title={t("同名候选不止一个的调用。默认隐藏，因为无法确定真正指向哪一个")}
      >
        {t("多义边")}
      </Toggle>

      {/*
        截断必须说出来。热点函数有上百个调用方，画面上只画得下十几个，
        不标注的话这张图看起来就像「它只被这些地方调用」。
      */}
      {omitted > 0 && (
        <span
          className="text-[11px] text-[var(--color-warn)]"
          title={t("按调用次数取前若干条。完整列表在右侧详情的「关系」标签页")}
        >
          {t("另有 {count} 条未画", { count: omitted })}
        </span>
      )}
    </>
  );
}

function WalkControls() {
  const t = useT();
  const close = useAppStore((s) => s.closeWalk);
  const allCalls = useAppStore((s) => s.walkAllCalls);
  const setAllCalls = useAppStore((s) => s.setWalkAllCalls);
  return (
    <>
      <Toggle
        active={allCalls}
        onClick={() => setAllCalls(!allCalls)}
        title={t("把外部库和静态分析解析不了的调用也列为步骤")}
      >
        {t("全部调用")}
      </Toggle>
      <button type="button" onClick={close}
        className="rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)]">
        {t("返回结构图")}
      </button>
    </>
  );
}

/** 面包屑只在有聚焦或展开时出现，默认视图下它是纯噪音 */
function Breadcrumb() {
  const t = useT();
  const store = useAppStore();
  const parts: Array<{ key: string; label: string; onClick: () => void }> = [];

  if (store.callGraph) {
    parts.push({
      key: "callgraph",
      label: t("调用图 {name}", { name: store.callGraph.label }),
      onClick: () => store.closeCallGraph(),
    });
  }
  if (store.walk) {
    parts.push({
      key: "walk",
      label: t("走读 {name}", { name: store.walk.label }),
      onClick: () => store.closeWalk(),
    });
  }
  if (store.focus !== null) {
    parts.push({ key: "focus", label: t("聚焦 {name}", { name: labelOf(store.focus) }), onClick: () => store.setFocus(null) });
  }
  // 展开层数属于结构视图的状态，调用图模式下它既不可见也不可操作，
  // 显示出来只会让人以为面包屑描述的是眼前这张图
  if (store.expanded.length > 0 && !store.callGraph) {
    parts.push({
      key: "expanded",
      label: t("已展开 {count} 层", { count: store.expanded.length }),
      onClick: () => useAppStore.setState({ expanded: [] }),
    });
  }
  if (store.hiddenNodes.length > 0) {
    parts.push({
      key: "hidden",
      label: t("已隐藏 {count} 项", { count: store.hiddenNodes.length }),
      onClick: () => store.resetHidden(),
    });
  }

  if (parts.length === 0) return null;

  return (
    <div data-breadcrumb className="anim-fade flex shrink-0 items-center gap-1.5">
      {parts.map((part) => (
        <button
          key={part.key}
          type="button"
          onClick={part.onClick}
          className="group flex max-w-64 items-center gap-1 rounded-full border border-[var(--color-line)] bg-[var(--color-surface-2)] py-0.5 pl-2.5 pr-1.5 text-[11px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)]"
        >
          <span className="truncate">{part.label}</span>
          <span className="text-[var(--color-ink-faint)] group-hover:text-[var(--color-ink)]">×</span>
        </button>
      ))}
    </div>
  );
}

function EntriesPill() {
  const t = useT();
  const store = useAppStore();
  const open = store.treeOpen && store.panelTab === "entries";
  return (
    <button type="button" onClick={() => { store.setPanelTab("entries"); store.setTreeOpen(!open); }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
      style={{ borderColor: open ? "var(--color-accent)" : "var(--color-line)", color: open ? "var(--color-accent)" : "var(--color-ink-muted)" }}
      title={t("从 main、路由、CLI 命令等入口开始，单步走读代码怎么跑")} aria-label={t("入口")}>
      ⇢<span data-topbar-optional="2">{t("入口")}</span>
    </button>
  );
}

function ChangesPill() {
  const t = useT();
  const store = useAppStore();
  const changed = useChangesStore((s) => changedFileCount(s.index, store.showNoise));
  const open = store.treeOpen && store.panelTab === "changes";
  return (
    <button type="button" onClick={() => { store.setPanelTab("changes"); store.setTreeOpen(!open); }}
      className="flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[11px] transition-colors"
      style={{ borderColor: open ? "var(--color-accent)" : "var(--color-line)", color: open ? "var(--color-accent)" : "var(--color-ink-muted)" }}
      title={t("对比某个提交：这次改了哪些依赖、接口和入口")} aria-label={t("变更")}>
      Δ<span data-topbar-optional="2">{t("变更")}</span>
      {changed > 0 && <span className="tabular-nums">{changed}</span>}
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
  const t = useT();
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
      title={t("架构体检：{count} 处结构问题", { count: summary.total })}
    >
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      <span data-topbar-optional="2">{t("体检")}</span>
      {summary.total}
    </button>
  );
}
