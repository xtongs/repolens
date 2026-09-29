import type {
  FileDetailDto,
  NoteDto,
  PseudocodeStepDto,
  SymbolDetailDto,
} from "@repolens/core/types";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { ChatDock } from "../chat/ChatDock";
import { msg, useT } from "../i18n";
import { SelectionAsk } from "../chat/SelectionAsk";
import { PseudocodePanel, stepMarkerWidth, type StepQuote } from "../code/PseudocodePanel";
import { SourcePanel, type SourceFocus } from "../code/SourcePanel";
import { formatCount, languageColor, symbolGlyph } from "../lib/visual";
import { NoteList } from "../notes/NoteCard";
import { useAppStore } from "../store/useAppStore";
import { useChatStore } from "../store/useChatStore";
import { notesInRange, notesOnFile, notesOnScope, useNotes } from "../store/useNotesStore";
import { ResizablePanelHandle, useResizablePanel } from "./ResizablePanelHandle";
import { TabStrip } from "./TabStrip";

type Tab = "overview" | "params" | "pseudocode" | "source" | "relations" | "notes";

const TAB_LABELS: Record<Tab, string> = {
  overview: msg("概览"),
  params: msg("传参"),
  pseudocode: msg("伪代码"),
  source: msg("源码"),
  relations: msg("关系"),
  notes: msg("笔记"),
};

/** 标签页之间的跳转：伪代码步骤「在源码中定位」、概览里「查看伪代码」 */
interface TabNavigation {
  tab: Tab;
  setTab: (tab: Tab) => void;
  sourceFocus: SourceFocus | null;
  jumpToSource: (lines: [number, number]) => void;
  /** 各类详情自己算出挂在它上面的笔记，页签上显示条数 */
  setNoteCount: (count: number) => void;
}

/**
 * 右侧栏：上方是详情，底部停靠追问 AI。
 *
 * 分标签页是「隐藏」策略的直接落地：默认只加载概览，源码和关系
 * 这类重查询等到用户点开对应标签才发请求。没有选中项但对话开着时，
 * 对话独占整个侧栏。
 */
export function DetailDrawer() {
  const t = useT();
  const open = useAppStore((s) => s.drawerOpen);
  const selected = useAppStore((s) => s.selected);
  const chatOpen = useAppStore((s) => s.chatOpen);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const detailRequest = useAppStore((s) => s.detailRequest);
  const [tab, setTab] = useState<Tab>("overview");
  const [sourceFocus, setSourceFocus] = useState<SourceFocus | null>(null);
  const [noteCount, setNoteCount] = useState(0);
  const [content, setContent] = useState<HTMLDivElement | null>(null);
  const resize = useResizablePanel({
    side: "right",
    storageKey: "repolens:right-panel-custom-width",
    fallbackWidth: 400,
    minWidth: 320,
    maxWidth: 800,
  });

  const jumpToSource = (lines: [number, number]) => {
    setSourceFocus((current) => ({ lines, nonce: (current?.nonce ?? 0) + 1 }));
    setTab("source");
  };

  useEffect(() => {
    setTab("overview");
    setSourceFocus(null);
    setNoteCount(0);
  }, [selected]);

  // 必须排在上面的重置之后：选中项和请求同时到达时，以请求的页签为准
  useEffect(() => {
    if (detailRequest === null || detailRequest.nodeId !== selected) return;
    useAppStore.getState().clearDetailRequest();
    if (detailRequest.lines) jumpToSource(detailRequest.lines);
    else setTab(detailRequest.tab);
  }, [selected, detailRequest]);
  const detailVisible = open && selected !== null;
  if (!detailVisible && !chatOpen) return null;

  const isSymbol = selected?.startsWith("sym:") ?? false;
  const isFile = selected?.startsWith("file:") ?? false;
  const availableTabs: Tab[] = isSymbol
    ? ["overview", "params", "pseudocode", "source", "relations", "notes"]
    : isFile
      ? ["overview", "pseudocode", "source", "relations", "notes"]
      : /^(?:dir|pkg):/.test(selected ?? "") ? ["overview", "notes"] : ["overview"];

  const navigation: TabNavigation = { tab, setTab, sourceFocus, jumpToSource, setNoteCount };

  return (
    <aside
      className="anim-slide-right absolute right-0 top-0 z-30 flex h-full flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur"
      style={{ width: resize.width }}
    >
      <ResizablePanelHandle
        side="right"
        label={t("调整右侧边栏宽度")}
        width={resize.width}
        minWidth={resize.minWidth}
        maxWidth={resize.maxWidth}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onReset={resize.reset}
      />
      {detailVisible && selected !== null && (
        <>
          <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] pl-3 pr-2">
            <TabStrip scrollKey={`${selected}:${tab}`}>
              {availableTabs.map((key) => (
                <button
                  key={key}
                  type="button"
                  aria-pressed={tab === key}
                  onClick={() => setTab(key)}
                  className={`shrink-0 rounded px-2 py-1 text-[11.5px] transition-colors ${
                    tab === key
                      ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                      : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
                  }`}
                >
                  {t(TAB_LABELS[key])}
                  {key === "notes" && noteCount > 0 && (
                    <span className="ml-1 tabular-nums text-[var(--color-note)]">{noteCount}</span>
                  )}
                </button>
              ))}
            </TabStrip>
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label={t("关闭详情")}
              className="shrink-0 px-1 text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
            >
              ×
            </button>
          </div>

          <div ref={setContent} className="thin-scroll min-h-0 flex-1 overflow-y-auto">
            {isSymbol && <SymbolBody key={selected} id={selected} navigation={navigation} />}
            {isFile && <FileBody key={selected} id={selected} navigation={navigation} />}
            {!isSymbol && !isFile && <ScopeBody id={selected} navigation={navigation} />}
          </div>
          <SelectionAsk container={content} nodeId={selected} />
        </>
      )}
      <ChatDock detailVisible={detailVisible} />
    </aside>
  );
}

/** 把一步伪代码作为引用加进对话；带行号时指向源文件，服务端会附上那几行原文 */
function askAboutStep(quote: StepQuote, fileId: string, nodeId: string): void {
  const lines = quote.lines;
  useChatStore.getState().attach({
    key: `step:${nodeId}:${quote.text}`,
    kind: "quote",
    text: quote.text,
    nodeId: lines ? fileId : nodeId,
    lines,
    label: `${lines ? `L${lines[0]}${lines[1] === lines[0] ? "" : `–${lines[1]}`} · ` : ""}${quote.label.slice(0, 18)}`,
  });
}

// ---------------------------------------------------------------------------
// 符号
// ---------------------------------------------------------------------------

function SymbolBody({ id, navigation }: { id: string; navigation: TabNavigation }) {
  const t = useT();
  const { tab } = navigation;
  const rememberLabel = useChatStore((s) => s.rememberLabel);
  const [detail, setDetail] = useState<SymbolDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setSemanticLoading(false);
    setSemanticError(null);
    void api
      .symbol(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        rememberLabel(d.id, d.container ? `${d.container}.${d.name}` : d.name);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, rememberLabel]);

  const generateSemantics = (refresh = false) => {
    if (semanticLoading) return;
    setSemanticLoading(true);
    setSemanticError(null);
    void api
      .generateSymbolSemantics(id, refresh)
      .then((result) => {
        setDetail((current) =>
          current?.id === id
            ? {
                ...current, summary: result.summary, shortSummary: result.shortSummary ?? null,
                pseudocode: result.pseudocode ?? null, pseudocodeSteps: result.pseudocodeSteps ?? null,
              }
            : current,
        );
      })
      .catch((e: Error) => setSemanticError(e.message))
      .finally(() => setSemanticLoading(false));
  };

  // 摘要和伪代码是同一次生成：打开概览或伪代码标签时一起补齐，之后读缓存。
  useEffect(() => {
    if (
      (tab !== "overview" && tab !== "pseudocode") || detail === null ||
      (detail.summary && detail.shortSummary && detail.pseudocode) ||
      semanticLoading || semanticError
    ) return;
    generateSemantics();
  }, [tab, detail, semanticLoading, semanticError]);

  const allNotes = useNotes();
  const notes = useMemo(
    () => (detail ? notesInRange(allNotes, detail.filePath, detail.startLine, detail.endLine) : []),
    [allNotes, detail],
  );
  useNoteCount(navigation, notes.length);

  if (error) return <Empty>{error}</Empty>;
  if (!detail) return <Skeleton />;

  if (tab === "notes") return <NotesTab notes={notes} navigation={navigation} showPath={false} />;

  if (tab === "pseudocode") {
    return (
      <PseudocodePanel
        steps={detail.pseudocodeSteps ?? null}
        fileId={detail.fileId}
        from={detail.startLine}
        to={detail.endLine}
        loading={semanticLoading}
        error={semanticError}
        loadingLabel={t("正在理解这个符号并生成伪代码…")}
        onGenerate={generateSemantics}
        onJumpToSource={navigation.jumpToSource}
        onAsk={(quote) => askAboutStep(quote, detail.fileId, detail.id)}
      />
    );
  }

  if (tab === "params") {
    return (
      <div className="p-3">
        {detail.params.length === 0 ? (
          <Empty>{t("这个符号没有参数")}</Empty>
        ) : (
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="text-left text-[var(--color-ink-faint)]">
                <th className="pb-1.5 font-normal">{t("参数")}</th>
                <th className="pb-1.5 font-normal">{t("类型")}</th>
                <th className="pb-1.5 font-normal">{t("默认值")}</th>
              </tr>
            </thead>
            <tbody>
              {detail.params.map((param) => (
                <tr key={param.name} className="border-t border-[var(--color-line)]">
                  <td className="mono py-1.5 pr-2 align-top text-[var(--color-ink)]">
                    {param.variadic && <span className="text-[var(--color-ink-faint)]">…</span>}
                    {param.name}
                    {param.optional && <span className="text-[var(--color-ink-faint)]">?</span>}
                  </td>
                  <td className="mono py-1.5 pr-2 align-top text-[var(--color-accent)]">
                    {param.type ?? "—"}
                  </td>
                  <td className="mono py-1.5 align-top text-[var(--color-ink-faint)]">
                    {param.defaultValue ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {detail.returnType && (
          <div className="mt-3 border-t border-[var(--color-line)] pt-2.5">
            <Label>{t("返回")}</Label>
            <div className="mono mt-1 text-[11.5px] text-[var(--color-accent)]">
              {detail.returnType}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (tab === "source") {
    return (
      <SourcePanel
        fileId={detail.fileId}
        from={detail.startLine}
        to={detail.endLine}
        steps={detail.pseudocodeSteps}
        focus={navigation.sourceFocus}
        notes={notes}
      />
    );
  }

  if (tab === "relations") {
    return (
      <div className="p-3">
        <CallGraphButton detail={detail} />
        <RelationList title={t("调用它的")} items={detail.callers} />
        <RelationList title={t("它调用的")} items={detail.callees} />

        {detail.externalCallees.length > 0 && (
          <div className="mt-3">
            <Label>{t("外部调用")}</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {detail.externalCallees.map((ext) => (
                <span
                  key={ext.name}
                  className="mono rounded border border-[var(--color-line)] px-1.5 py-0.5 text-[10.5px] text-[var(--color-ink-faint)]"
                >
                  {ext.name} ×{ext.count}
                </span>
              ))}
            </div>
          </div>
        )}

        {detail.callers.length === 0 &&
          detail.callees.length === 0 &&
          detail.externalCallees.length === 0 && (
            <Empty>{t("没有解析出调用关系。可能它只被动态调用，或者调用方都在索引范围之外。")}</Empty>
          )}
      </div>
    );
  }

  const accent = languageColor(detail.language);

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span className="mono text-[13px]" style={{ color: accent }}>
          {symbolGlyph(detail.kind)}
        </span>
        <span className="truncate text-[14px] font-medium">
          {detail.container ? `${detail.container}.${detail.name}` : detail.name}
        </span>
        {detail.exported && (
          <span className="shrink-0 rounded border border-[var(--color-line)] px-1 text-[9.5px] text-[var(--color-ink-faint)]">
            exported
          </span>
        )}
      </div>

      <div className="mono mt-1 truncate text-[10.5px] text-[var(--color-ink-faint)]">
        {detail.filePath}:{detail.startLine}
      </div>

      {detail.signature && (
        <pre className="mono mt-2.5 overflow-x-auto whitespace-pre-wrap rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2.5 text-[11px] leading-relaxed">
          {detail.signature}
        </pre>
      )}

      {detail.doc && (
        <div className="mt-2.5">
          <Label>{t("文档注释")}</Label>
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.doc}
          </p>
        </div>
      )}

      {detail.summary ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label ai>{t("AI 摘要")}</Label>
            <SemanticRefreshButton loading={semanticLoading} onClick={() => generateSemantics(true)} />
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.summary}
          </p>
          {semanticError && (
            <div className="mt-2 text-[11px] text-[var(--color-warn)]">{t("刷新失败：{error}", { error: semanticError })}</div>
          )}
          <PseudocodeLink steps={detail.pseudocodeSteps} onOpen={() => navigation.setTab("pseudocode")} />
        </div>
      ) : semanticLoading ? (
        <SemanticLoading label={t("正在生成函数摘要与伪代码…")} />
      ) : semanticError ? (
        <div className="mt-2">
          <div className="text-[11px] text-[var(--color-warn)]">{semanticError}</div>
          <RetryButton onClick={generateSemantics}>{t("重试")}</RetryButton>
        </div>
      ) : (
        <RetryButton onClick={generateSemantics}>{t("生成 AI 摘要与伪代码")}</RetryButton>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label={t("行数")} value={String(detail.endLine - detail.startLine + 1)} />
        <Metric label={t("复杂度")} value={String(detail.complexity)} />
        <Metric label={t("种类")} value={detail.kind} />
      </div>

      {detail.typeRelations.length > 0 && (
        <div className="mt-3">
          <Label>{t("类型关系")}</Label>
          <div className="mt-1.5 space-y-1">
            {detail.typeRelations.map((rel, i) => (
              <div key={`${rel.relation}-${rel.target}-${i}`} className="text-[11.5px]">
                <span className="text-[var(--color-ink-faint)]">{rel.relation}</span>{" "}
                <span className="mono text-[var(--color-ink)]">{rel.target}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 把当前符号切成画布上的调用图中心 */
function CallGraphButton({ detail }: { detail: SymbolDetailDto }) {
  const t = useT();
  const openCallGraph = useAppStore((s) => s.openCallGraph);
  const label = detail.container ? `${detail.container}.${detail.name}` : detail.name;
  const total = detail.callers.length + detail.callees.length;
  if (total === 0) return null;

  return (
    <button
      type="button"
      onClick={() => void openCallGraph(Number(detail.id.slice("sym:".length)), label)}
      className="mb-3 w-full rounded border border-[var(--color-line-strong)] px-2 py-1.5 text-[11.5px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-accent)] hover:text-[var(--color-ink)]"
    >
      {t("在画布上展开调用图")}
    </button>
  );
}

function RelationList({
  title,
  items,
}: {
  title: string;
  items: SymbolDetailDto["callers"];
}) {
  const select = useAppStore((s) => s.select);
  if (items.length === 0) return null;

  return (
    <div className="mb-3">
      <Label>
        {title} ({items.length})
      </Label>
      <div className="mt-1.5 space-y-0.5">
        {items.map((item) => (
          <div key={`${item.id}-${item.line}`}>
            <button
              type="button"
              onClick={() => select(item.id)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-2)]"
            >
              <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">
                {item.name}
              </span>
              <ConfidenceBadge value={item.confidence} />
              <span className="mono ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
                {item.path.split("/").at(-1)}:{item.line}
              </span>
            </button>

            {/*
              多义关系必须把其他候选摊开。只显示一个猜出来的目标，
              等于把「同名的有 5 个，我挑了第一个」讲成了确定的事实。
            */}
            {item.candidates && item.candidates.length > 1 && (
              <div className="ml-1.5 border-l border-[var(--color-line)] pl-2">
                {item.candidates.map((cand) => (
                  <button
                    key={cand.id}
                    type="button"
                    onClick={() => select(cand.id)}
                    className="mono block w-full truncate-start truncate py-0.5 text-left text-[10px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
                  >
                    {cand.path}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function ConfidenceBadge({ value }: { value: string }) {
  const t = useT();
  const styles: Record<string, string> = {
    exact: "border-[var(--color-accent)]/40 text-[var(--color-accent)]",
    likely: "border-[var(--color-warn)]/40 text-[var(--color-warn)]",
    ambiguous: "border-[var(--color-line-strong)] text-[var(--color-ink-faint)]",
    external: "border-[var(--color-line)] text-[var(--color-ink-faint)]",
    unresolved: "border-[var(--color-line)] text-[var(--color-ink-faint)]",
  };
  const labels: Record<string, string> = {
    exact: t("确定"),
    likely: t("可能"),
    ambiguous: t("多义"),
    external: t("外部"),
    unresolved: t("未解析"),
  };
  return (
    <span
      className={`shrink-0 rounded border px-1 text-[9.5px] ${styles[value] ?? styles["unresolved"]}`}
    >
      {labels[value] ?? value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// 文件
// ---------------------------------------------------------------------------

function FileBody({ id, navigation }: { id: string; navigation: TabNavigation }) {
  const t = useT();
  const { tab } = navigation;
  const select = useAppStore((s) => s.select);
  const rememberLabel = useChatStore((s) => s.rememberLabel);
  const [detail, setDetail] = useState<FileDetailDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [semanticLoading, setSemanticLoading] = useState(false);
  const [semanticError, setSemanticError] = useState<string | null>(null);
  const [semanticSkipReason, setSemanticSkipReason] = useState<"empty-file" | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError(null);
    setSemanticLoading(false);
    setSemanticError(null);
    setSemanticSkipReason(null);
    void api
      .file(id)
      .then((d) => {
        if (cancelled) return;
        setDetail(d);
        rememberLabel(d.id, d.path.split("/").at(-1) ?? d.path);
      })
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id, rememberLabel]);

  const generateSummary = (refresh = false) => {
    if (semanticLoading) return;
    setSemanticLoading(true);
    setSemanticError(null);
    void api
      .generateFileSummary(id, refresh)
      .then((result) => {
        setSemanticSkipReason(result.skipReason ?? null);
        setDetail((current) => (current?.id === id
          ? {
              ...current, summary: result.summary, shortSummary: result.shortSummary ?? null,
              pseudocode: result.pseudocode ?? null, pseudocodeSteps: result.pseudocodeSteps ?? null,
            }
          : current));
      })
      .catch((e: Error) => setSemanticError(e.message))
      .finally(() => setSemanticLoading(false));
  };

  // 文件语义是一个整体：摘要、Tooltip 单句和文件伪代码缺一项都补齐。
  useEffect(() => {
    if (
      detail === null ||
      detail.bytes === 0 || semanticSkipReason === "empty-file" ||
      (detail.summary && detail.shortSummary && detail.pseudocode) ||
      semanticLoading || semanticError
    ) return;
    generateSummary();
  }, [detail, semanticLoading, semanticError, semanticSkipReason]);

  const allNotes = useNotes();
  const notes = useMemo(() => (detail ? notesOnFile(allNotes, detail.path) : []), [allNotes, detail]);
  useNoteCount(navigation, notes.length);

  if (error) return <Empty>{error}</Empty>;
  if (!detail) return <Skeleton />;

  if (tab === "notes") return <NotesTab notes={notes} navigation={navigation} showPath={false} />;

  const empty = detail.bytes === 0 || semanticSkipReason === "empty-file";

  if (tab === "pseudocode") {
    if (empty) return <Empty>{t("空文件，没有可生成的伪代码")}</Empty>;
    return (
      <PseudocodePanel
        steps={detail.pseudocodeSteps ?? null}
        fileId={detail.id}
        loading={semanticLoading}
        error={semanticError}
        loadingLabel={t("正在分析文件内函数与整体逻辑…")}
        onGenerate={generateSummary}
        onJumpToSource={navigation.jumpToSource}
        onAsk={(quote) => askAboutStep(quote, detail.id, detail.id)}
      />
    );
  }

  if (tab === "source") {
    return (
      <SourcePanel fileId={detail.id} steps={detail.pseudocodeSteps} focus={navigation.sourceFocus} notes={notes} />
    );
  }

  if (tab === "relations") {
    return (
      <div className="p-3">
        <Label>{t("依赖 ({count})", { count: detail.imports.length })}</Label>
        <div className="mt-1.5 space-y-0.5">
          {detail.imports.map((imp, i) => (
            <div
              key={`${imp.source}-${imp.line}-${i}`}
              className="flex items-center gap-2 rounded px-1.5 py-1 text-[11.5px]"
            >
              <span className="mono truncate text-[var(--color-ink)]">{imp.source}</span>
              <ConfidenceBadge value={imp.confidence} />
              {imp.targetPath && (
                <span className="mono ml-auto shrink-0 truncate text-[10px] text-[var(--color-ink-faint)]">
                  {imp.targetPath}
                </span>
              )}
            </div>
          ))}
        </div>

        <div className="mt-3">
          <Label>{t("被依赖 ({count})", { count: detail.importedBy.length })}</Label>
          <div className="mt-1.5 space-y-0.5">
            {detail.importedBy.map((ref) => (
              <button
                key={ref.id}
                type="button"
                onClick={() => select(ref.id)}
                className="mono block w-full truncate rounded px-1.5 py-1 text-left text-[11px] text-[var(--color-ink-muted)] transition-colors hover:bg-[var(--color-surface-2)]"
              >
                {ref.path}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="p-3">
      <div className="flex items-center gap-2">
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ background: languageColor(detail.language) }}
        />
        <span className="truncate text-[14px] font-medium">{detail.path.split("/").at(-1)}</span>
        <span className="ml-auto shrink-0 text-[10px] text-[var(--color-ink-faint)]">
          {detail.role}
        </span>
      </div>
      <div className="mono mt-1 break-all text-[10.5px] text-[var(--color-ink-faint)]">
        {detail.path}
      </div>

      {detail.parseError && (
        <div className="mt-2 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/5 px-2 py-1.5 text-[11px] text-[var(--color-warn)]">
          {detail.parseError}
        </div>
      )}

      {empty ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2.5 text-[11.5px] text-[var(--color-ink-faint)]">
          {t("空文件，没有可生成的内容")}
        </div>
      ) : detail.summary ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <div className="flex items-center justify-between gap-2">
            <Label ai>{t("AI 摘要")}</Label>
            <SemanticRefreshButton loading={semanticLoading} onClick={() => generateSummary(true)} />
          </div>
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.summary}
          </p>
          {semanticError && (
            <div className="mt-2 text-[11px] text-[var(--color-warn)]">{t("刷新失败：{error}", { error: semanticError })}</div>
          )}
          <PseudocodeLink steps={detail.pseudocodeSteps} onOpen={() => navigation.setTab("pseudocode")} />
        </div>
      ) : semanticLoading || !semanticError ? (
        <SemanticLoading label={t("正在生成文件摘要与伪代码…")} />
      ) : semanticError ? (
        <div className="mt-2">
          <div className="text-[11px] text-[var(--color-warn)]">{semanticError}</div>
          <RetryButton onClick={generateSummary}>{t("重试")}</RetryButton>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-4 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label={t("代码行")} value={formatCount(detail.loc)} />
        <Metric label={t("符号数")} value={String(detail.symbols.length)} />
        <Metric label={t("依赖")} value={String(detail.imports.length)} />
        <Metric label={t("被依赖")} value={String(detail.importedBy.length)} />
      </div>

      <div className="mt-3">
        <Label>{t("符号 ({count})", { count: detail.symbols.length })}</Label>
        <div className="mt-1.5 space-y-0.5">
          {detail.symbols.map((sym) => (
            <button
              key={sym.id}
              type="button"
              onClick={() => select(sym.id)}
              className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors hover:bg-[var(--color-surface-2)]"
            >
              <span
                className="mono w-3 shrink-0 text-[10px]"
                style={{ color: languageColor(detail.language) }}
              >
                {symbolGlyph(sym.kind)}
              </span>
              <span className="mono truncate text-[11.5px] text-[var(--color-ink)]">
                {sym.container ? `${sym.container}.${sym.name}` : sym.name}
              </span>
              {!sym.exported && (
                <span className="shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{t("内部")}</span>
              )}
              <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
                {sym.startLine}
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 包 / 目录 / 聚合
// ---------------------------------------------------------------------------

function ScopeBody({ id, navigation }: { id: string; navigation: TabNavigation }) {
  const t = useT();
  const store = useAppStore();
  const allNotes = useNotes();
  const notes = useMemo(() => notesOnScope(allNotes, id), [allNotes, id]);
  useNoteCount(navigation, notes.length);
  const graph = store.subgraphs[store.rootScope];
  const node =
    Object.values(store.subgraphs)
      .flatMap((g) => g.nodes)
      .find((n) => n.id === id) ?? graph?.nodes.find((n) => n.id === id);

  if (navigation.tab === "notes") return <NotesTab notes={notes} navigation={navigation} showPath />;
  if (!node) return <Empty>{t("找不到这个节点")}</Empty>;

  return (
    <div className="p-3">
      <div className="text-[14px] font-medium">{node.label}</div>
      {node.path && (
        <div className="mono mt-1 break-all text-[10.5px] text-[var(--color-ink-faint)]">
          {node.path}
        </div>
      )}

      {node.layer && (
        <div className="mt-2 text-[10px] text-[var(--color-accent)]">{t("AI 架构层 · {layer}", { layer: node.layer })}</div>
      )}
      {node.summary && (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <Label ai>{t("AI 摘要")}</Label>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">{node.summary}</p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label={t("代码行")} value={formatCount(node.metrics.loc)} />
        <Metric label={t("文件数")} value={formatCount(node.metrics.files)} />
        <Metric label={t("符号数")} value={formatCount(node.metrics.symbols)} />
        <Metric label={t("复杂度")} value={formatCount(node.metrics.complexity)} />
        <Metric label={t("依赖")} value={String(node.metrics.outDegree)} />
        <Metric label={t("被依赖")} value={String(node.metrics.inDegree)} />
      </div>

      {node.expandable && (
        <button
          type="button"
          onClick={() => void store.toggleExpand(node)}
          className="mt-3 w-full rounded-md border border-[var(--color-line)] py-1.5 text-[11.5px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
        >
          {store.expanded.includes(node.id) ? t("收起子项") : t("展开 {count} 项", { count: node.childCount })}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 小组件
// ---------------------------------------------------------------------------

function Label({ children, ai }: { children: React.ReactNode; ai?: boolean }) {
  return (
    <div
      className="text-[10px] uppercase tracking-wider"
      style={{ color: ai ? "var(--color-accent)" : "var(--color-ink-faint)" }}
    >
      {children}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] text-[var(--color-ink-faint)]">{label}</div>
      <div className="mt-0.5 truncate text-[12.5px] tabular-nums text-[var(--color-ink)]">
        {value}
      </div>
    </div>
  );
}

function useNoteCount(navigation: TabNavigation, count: number): void {
  const { setNoteCount } = navigation;
  useEffect(() => setNoteCount(count), [setNoteCount, count]);
}

/** 文件和符号里点笔记的位置就地滚动源码；目录里的笔记分散在各个文件，要跳过去 */
function NotesTab({ notes, navigation, showPath }: { notes: NoteDto[]; navigation: TabNavigation; showPath: boolean }) {
  const t = useT();
  return (
    <div className="p-3">
      <NoteList
        notes={notes}
        showPath={showPath}
        empty={t("还没有笔记。在追问 AI 的回答里划选文字、或点回答下方的「记笔记」，就能存到这里。")}
        onLocate={showPath ? undefined : (note) => {
          const lines = note.target.kind === "file" ? note.target.lines : null;
          return lines ? () => navigation.jumpToSource(lines) : null;
        }}
      />
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="p-3 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">{children}</div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 p-3">
      {[...Array(5)].map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-[var(--color-surface-3)]"
          style={{ width: `${90 - i * 12}%` }}
        />
      ))}
    </div>
  );
}

function SemanticLoading({ label }: { label: string }) {
  return (
    <div className="mt-2 flex items-center gap-2 rounded border border-[var(--color-accent)]/20 bg-[var(--color-accent)]/5 px-2.5 py-2 text-[11px] text-[var(--color-ink-muted)]">
      <span className="h-2 w-2 animate-pulse rounded-full bg-[var(--color-accent)]" />
      {label}
    </div>
  );
}

/** 伪代码有了独立标签页，概览里只留一行入口，列出前两步让人知道值不值得点开 */
/** 概览里只列顶层步骤、每步一行，当作提纲；子步骤和源码对应留给伪代码标签。 */
function PseudocodeLink({ steps, onOpen }: { steps: PseudocodeStepDto[] | null | undefined; onOpen: () => void }) {
  const t = useT();
  if (!steps || steps.length === 0) return null;
  const markerWidth = stepMarkerWidth(steps.length);
  return (
    <button
      type="button"
      onClick={onOpen}
      title={t("查看完整伪代码")}
      className="group mt-2.5 block w-full border-t border-[var(--color-accent)]/20 pt-2 text-left"
    >
      <span className="flex items-baseline">
        <span className="text-[10px] uppercase tracking-wider text-[var(--color-accent)]">{t("伪代码 {count} 步", { count: steps.length })}</span>
        <span className="ml-auto text-[11px] text-[var(--color-ink-faint)] group-hover:text-[var(--color-accent)]">→</span>
      </span>
      <span className="mt-1 block space-y-0.5">
        {steps.map((step, index) => (
          <span key={index} className="flex items-baseline gap-1.5">
            <span className={`mono ${markerWidth} shrink-0 text-[10.5px] tabular-nums text-[var(--color-accent)]`}>
              {index + 1}
            </span>
            <span className="truncate text-[11px] text-[var(--color-ink-muted)]">{step.text}</span>
          </span>
        ))}
      </span>
    </button>
  );
}

function SemanticRefreshButton({ loading, onClick }: { loading: boolean; onClick: () => void }) {
  const t = useT();
  return (
    <button
      type="button"
      disabled={loading}
      onClick={onClick}
      aria-label={loading ? t("正在重新生成 AI 摘要") : t("重新生成 AI 摘要")}
      title={loading ? t("正在重新生成…") : t("重新生成 AI 摘要")}
      className="flex h-5 w-5 shrink-0 items-center justify-center rounded text-[14px] leading-none text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-accent)] disabled:cursor-wait disabled:opacity-60"
    >
      <span className={loading ? "animate-spin" : ""}>↻</span>
    </button>
  );
}

function RetryButton({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 rounded border border-[var(--color-accent)]/40 px-2 py-1 text-[10.5px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/10"
    >
      {children}
    </button>
  );
}
