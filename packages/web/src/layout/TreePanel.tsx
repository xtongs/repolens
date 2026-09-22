import type { EntryPointDto, FindingDto, TraceSummaryDto, TreeNodeDto } from "@repolens/core/types";
import { useCallback, useEffect, useMemo, useState } from "react";
import { type FindingsResponse, api } from "../api/client";
import { formatCount, languageColor } from "../lib/visual";
import { ALL_VISIBLE_ROLES, SOURCE_ONLY_ROLES, useAppStore } from "../store/useAppStore";
import { ResizablePanelHandle, useResizablePanel } from "./ResizablePanelHandle";

/**
 * 结构树。
 *
 * 覆盖在画布之上而不是挤压画布——布局抖动会让用户丢失在图上的视觉焦点，
 * 这个代价比多占一点空间大得多。
 */
export function TreePanel() {
  const open = useAppStore((s) => s.treeOpen);
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const setTreeOpen = useAppStore((s) => s.setTreeOpen);
  const tab = useAppStore((s) => s.panelTab);
  const setTab = useAppStore((s) => s.setPanelTab);
  const resize = useResizablePanel({
    side: "left",
    storageKey: "repolens:left-panel-width",
    defaultWidth: 300,
    minWidth: 240,
    maxWidth: 560,
  });

  if (!open) return null;

  return (
    <aside
      className="anim-slide-left absolute left-0 top-0 z-30 flex h-full flex-col border-r border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur"
      style={{ width: resize.width }}
    >
      <ResizablePanelHandle
        side="left"
        label="调整左侧边栏宽度"
        width={resize.width}
        minWidth={resize.minWidth}
        maxWidth={resize.maxWidth}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onReset={resize.reset}
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-3">
        <PanelTab active={tab === "tree"} onClick={() => setTab("tree")} label="结构" />
        <PanelTab active={tab === "findings"} onClick={() => setTab("findings")} label="体检" />
        <PanelTab active={tab === "traces"} onClick={() => setTab("traces")} label="链路" />
        <button
          type="button"
          onClick={() => setTreeOpen(false)}
          className="ml-auto text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        >
          ×
        </button>
      </div>

      {tab === "tree" ? (
        <TreeBody key={`tree:${repoId ?? ""}:${repoRevision}`} />
      ) : tab === "findings" ? (
        <FindingsBody key={`findings:${repoId ?? ""}:${repoRevision}`} />
      ) : (
        <TracesBody key={`traces:${repoId ?? ""}:${repoRevision}`} />
      )}
    </aside>
  );
}

function TracesBody() {
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const showNoise = useAppStore((s) => s.showNoise);
  const openTrace = useAppStore((s) => s.openTrace);
  const activeTrace = useAppStore((s) => s.traceId);
  const [entries, setEntries] = useState<EntryPointDto[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [traces, setTraces] = useState<Record<string, TraceSummaryDto[]>>({});
  const [showUntraced, setShowUntraced] = useState(false);

  useEffect(() => {
    let stale = false;
    setEntries(null);
    setExpanded(null);
    setTraces({});
    setShowUntraced(false);
    void api.entries().then((value) => { if (!stale) setEntries(value); }).catch(() => { if (!stale) setEntries([]); });
    return () => { stale = true; };
  }, [repoId, repoRevision]);

  const visibleEntries = useMemo(
    () => sortEntries((entries ?? []).filter(
      (entry) => showNoise || (entry.kind !== "test" && entry.fileRole !== "test"),
    )),
    [entries, showNoise],
  );
  const tracedEntries = visibleEntries.filter((entry) => entry.traceCount > 0);
  const untracedEntries = visibleEntries.filter((entry) => entry.traceCount === 0);

  const toggle = async (entry: EntryPointDto) => {
    if (expanded === entry.id) { setExpanded(null); return; }
    setExpanded(entry.id);
    if (traces[entry.id]) return;
    try {
      const value = await api.traces(entry.id);
      setTraces((current) => ({ ...current, [entry.id]: value }));
    } catch {
      setTraces((current) => ({ ...current, [entry.id]: [] }));
    }
  };

  if (entries === null) return <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">加载中…</div>;
  if (visibleEntries.length === 0) return (
    <div className="px-3 py-4 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
      没有识别到入口。重新扫描后可识别 main、HTTP 路由、CLI、公共 API 与测试入口。
    </div>
  );

  return (
    <>
      <div className="shrink-0 px-3 pt-2 text-[10.5px] text-[var(--color-ink-faint)]">
        可追踪入口 · 终点为数据库、网络、文件等 I/O
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto py-1">
        {tracedEntries.map((entry) => (
          <TraceEntryRow
            key={entry.id}
            entry={entry}
            expanded={expanded === entry.id}
            activeTrace={activeTrace}
            traces={traces[entry.id]}
            onToggle={() => void toggle(entry)}
            onOpen={openTrace}
          />
        ))}
        {tracedEntries.length === 0 && (
          <div className="px-3 py-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
            没有入口能沿当前静态调用关系到达 I/O 边界。
          </div>
        )}
        {untracedEntries.length > 0 && (
          <div className="mt-1 border-t border-[var(--color-line)]/60 pt-1">
            <button
              type="button"
              onClick={() => setShowUntraced((value) => !value)}
              aria-expanded={showUntraced}
              className="flex w-full items-center px-3 py-1.5 text-left text-[10.5px] text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink-muted)]"
            >
              <span>未形成链路的入口</span>
              <span className="ml-auto tabular-nums">{untracedEntries.length}</span>
              <span className="ml-2 w-6 text-right">{showUntraced ? "收起" : "显示"}</span>
            </button>
            {showUntraced && untracedEntries.map((entry) => (
              <TraceEntryRow
                key={entry.id}
                entry={entry}
                expanded={false}
                activeTrace={activeTrace}
                traces={[]}
                onToggle={() => {}}
                onOpen={openTrace}
              />
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function TraceEntryRow({
  entry,
  expanded,
  activeTrace,
  traces,
  onToggle,
  onOpen,
}: {
  entry: EntryPointDto;
  expanded: boolean;
  activeTrace: string | null;
  traces: TraceSummaryDto[] | undefined;
  onToggle: () => void;
  onOpen: (id: string, label: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        disabled={entry.traceCount === 0}
        aria-expanded={expanded}
        title={entry.traceCount > 0 ? `展开 ${entry.traceCount} 条链路` : "未追踪到 I/O 边界"}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left enabled:hover:bg-[var(--color-surface-raised)] disabled:cursor-default"
      >
        <span className="rounded border border-[var(--color-line)] px-1 text-[9px] uppercase text-[var(--color-accent)]">
          {entryKindLabel(entry.kind)}
        </span>
        <span className="min-w-0 flex-1 truncate text-[11.5px]">{entry.label}</span>
        <span className="ml-auto text-[10px] tabular-nums text-[var(--color-ink-faint)]">
          {entry.traceCount > 0 ? entry.traceCount : "未形成"}
        </span>
      </button>
      {expanded && (
        <div className="border-y border-[var(--color-line)]/60 bg-[var(--color-canvas)]/30 py-1">
          {!traces ? (
            <div className="px-7 py-2 text-[10.5px] text-[var(--color-ink-faint)]">加载链路…</div>
          ) : traces.length === 0 ? (
            <div className="px-7 py-2 text-[10.5px] text-[var(--color-ink-faint)]">未沿确定调用边到达 I/O 边界</div>
          ) : traces.map((trace) => (
            <button
              key={trace.id}
              type="button"
              onClick={() => onOpen(trace.id, trace.label)}
              className={`block w-full px-7 py-1.5 text-left hover:bg-[var(--color-surface-3)] ${
                activeTrace === trace.id ? "bg-[var(--color-surface-3)]" : ""
              }`}
            >
              <div className="truncate text-[11px]">{trace.label}</div>
              <div className="mt-0.5 text-[9.5px] text-[var(--color-ink-faint)]">
                {trace.steps} 步 · {trace.confidence === "exact" ? "确定" : "含推断"}
                {trace.hasNarrative ? " · AI 已解释" : ""}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function entryKindLabel(kind: EntryPointDto["kind"]): string {
  return ({ main: "main", cli: "cli", http: "http", "public-api": "api", test: "test" })[kind];
}

const ENTRY_KIND_ORDER: Record<EntryPointDto["kind"], number> = {
  http: 0, cli: 1, main: 2, "public-api": 3, test: 4,
};

function sortEntries(entries: readonly EntryPointDto[]): EntryPointDto[] {
  return [...entries].sort((a, b) =>
    Number(b.traceCount > 0) - Number(a.traceCount > 0) ||
    ENTRY_KIND_ORDER[a.kind] - ENTRY_KIND_ORDER[b.kind] ||
    b.traceCount - a.traceCount ||
    a.label.localeCompare(b.label) ||
    a.filePath.localeCompare(b.filePath) ||
    a.line - b.line,
  );
}

function PanelTab({
  active,
  onClick,
  label,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-2 py-0.5 text-[12px] transition-colors ${
        active
          ? "bg-[var(--color-surface-raised)] font-medium text-[var(--color-ink)]"
          : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
      }`}
    >
      {label}
    </button>
  );
}

function TreeBody() {
  const showNoise = useAppStore((s) => s.showNoise);
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const [root, setRoot] = useState<TreeNodeDto | null>(null);

  const roles = (showNoise ? ALL_VISIBLE_ROLES : SOURCE_ONLY_ROLES).join(",");

  useEffect(() => {
    let cancelled = false;
    setRoot(null);
    void api
      .tree(".", 1, roles)
      .then((tree) => {
        if (!cancelled) setRoot(tree);
      })
      .catch(() => {
        if (!cancelled) setRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, repoRevision, roles]);

  return (
    <>
      <div className="shrink-0 px-3 pt-2 text-[10.5px] text-[var(--color-ink-faint)]">
        按代码行热力排序
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto py-1">
        {root === null ? (
          <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">加载中…</div>
        ) : (
          (root.children ?? []).map((child) => (
            <TreeRow key={child.id} node={child} depth={0} roles={roles} />
          ))
        )}
      </div>
    </>
  );
}

function TreeRow({ node, depth, roles }: { node: TreeNodeDto; depth: number; roles: string }) {
  const select = useAppStore((s) => s.select);
  const selected = useAppStore((s) => s.selected === node.id);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeNodeDto[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);

  const toggle = useCallback(async () => {
    if (node.kind === "file") return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    if (children !== null) return;
    setLoading(true);
    try {
      const sub = await api.tree(node.path, 1, roles);
      setChildren(sub.children ?? []);
    } finally {
      setLoading(false);
    }
  }, [expanded, children, node.kind, node.path, roles]);

  return (
    <>
      <div
        role="treeitem"
        aria-expanded={node.kind === "directory" ? expanded : undefined}
        tabIndex={0}
        onClick={() => select(node.id)}
        onDoubleClick={() => void toggle()}
        onKeyDown={(event) => {
          if (event.key === "Enter") select(node.id);
          if (event.key === " ") {
            event.preventDefault();
            void toggle();
          }
        }}
        className={`group relative flex cursor-pointer items-center gap-1.5 py-[3px] pr-3 text-[12px] transition-colors ${
          selected ? "bg-[var(--color-surface-3)]" : "hover:bg-[var(--color-surface-2)]"
        }`}
        style={{ paddingLeft: 13 + depth * 13 }}
      >
        {/* 热力条：宽度即该项在同级中的相对体量，不占额外的行 */}
        <span
          className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--color-accent)]/8"
          style={{ width: `${Math.max(2, node.heat * 100)}%` }}
        />

        {node.kind === "directory" ? (
          <FolderIcon open={expanded} />
        ) : (
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: languageColor(node.language) }}
            />
          </span>
        )}

        <span className="relative truncate text-[var(--color-ink)]">{node.name}</span>

        <span className="relative ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
          {formatCount(node.loc)}
        </span>
      </div>

      {expanded && loading && (
        <div
          className="py-1 text-[10.5px] text-[var(--color-ink-faint)]"
          style={{ paddingLeft: 26 + depth * 13 }}
        >
          加载中…
        </div>
      )}

      {expanded &&
        children?.map((child) => (
          <TreeRow key={child.id} node={child} depth={depth + 1} roles={roles} />
        ))}
    </>
  );
}

/**
 * 目录使用明确的文件夹图标，而不是中性圆点。圆点在结构树中只表示文件语言，
 * 避免用户把目录的灰点误解成一种语言；文件夹自身的开合形态表达展开状态。
 */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="relative h-3.5 w-3.5 shrink-0 text-[var(--color-ink-muted)]"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.35"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {open ? (
        <>
          <path d="M1.75 4.75h4l1.2 1.5h7.3" />
          <path d="M2.25 4.75V3.5c0-.55.45-1 1-1h2.1l1.2 1.5h5.2c.55 0 1 .45 1 1v1.25" />
          <path d="M1.75 6.25h12.5l-1.35 6.1c-.1.47-.52.8-1 .8H3.1c-.48 0-.9-.33-1-.8L.75 7.45c-.14-.62.34-1.2 1-1.2Z" />
        </>
      ) : (
        <path d="M1.75 4.25c0-.55.45-1 1-1h2.7l1.3 1.5h6.5c.55 0 1 .45 1 1v6.5c0 .55-.45 1-1 1H2.75c-.55 0-1-.45-1-1v-8Z" />
      )}
    </svg>
  );
}

/**
 * 体检清单。
 *
 * 刻意不做成弹窗或独立页面：它是一份「该去看哪里」的待办，和结构树是同一类
 * 导航物件，所以复用同一个面板槽位做标签页，不新增门面。
 *
 * 一条结论只列一次（服务端按 group_key 去重），点击落到图上对应节点。
 */
function FindingsBody() {
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const [data, setData] = useState<FindingsResponse | null>(null);
  const [kind, setKind] = useState<"all" | "duplicate" | "cycle">("all");
  const reveal = useAppStore((s) => s.reveal);
  const selected = useAppStore((s) => s.selected);

  useEffect(() => {
    let cancelled = false;
    setData(null);
    void api
      .findings(kind === "all" ? undefined : kind)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, repoId, repoRevision]);

  if (data === null) {
    return <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">加载中…</div>;
  }

  if (data.summary.total === 0) {
    return (
      <div className="px-3 py-4 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
        没有发现结构问题。
        <br />
        当前检查项：跨文件的重复实现、同级作用域之间的循环依赖。
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 items-center gap-1 px-3 pt-2">
        <FilterChip active={kind === "all"} onClick={() => setKind("all")}>
          全部 {data.summary.total}
        </FilterChip>
        <FilterChip active={kind === "duplicate"} onClick={() => setKind("duplicate")}>
          重复 {data.summary.byKind["duplicate"] ?? 0}
        </FilterChip>
        <FilterChip active={kind === "cycle"} onClick={() => setKind("cycle")}>
          循环 {data.summary.byKind["cycle"] ?? 0}
        </FilterChip>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto py-1">
        {data.items.map((item) => (
          <button
            key={item.groupKey}
            type="button"
            onClick={() => void reveal(item.scopeKey)}
            title={item.detail}
            className={`block w-full px-3 py-1.5 text-left transition-colors hover:bg-[var(--color-surface-raised)] ${
              selected === item.scopeKey ? "bg-[var(--color-surface-raised)]" : ""
            }`}
          >
            <div className="flex items-baseline gap-1.5">
              <span
                className="mt-[3px] h-1.5 w-1.5 shrink-0 rounded-full"
                style={{ background: severityColor(item.severity) }}
              />
              <span className="truncate text-[11.5px] text-[var(--color-ink)]">{item.title}</span>
            </div>
            <div className="mono truncate-start ml-3 truncate text-[10px] text-[var(--color-ink-faint)]">
              {item.path}
            </div>
          </button>
        ))}
      </div>
    </>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded px-1.5 py-0.5 text-[10.5px] transition-colors ${
        active
          ? "bg-[var(--color-accent)]/18 text-[var(--color-accent)]"
          : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
      }`}
    >
      {children}
    </button>
  );
}

function severityColor(severity: FindingDto["severity"]): string {
  if (severity === "high") return "var(--color-danger)";
  if (severity === "medium") return "var(--color-warn)";
  return "var(--color-ink-faint)";
}
