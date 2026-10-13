import type {
  EntryPointDto,
  ExclusionReason,
  FileRole,
  FindingDto,
  FindingKind,
  TreeNodeDto,
} from "@repolens/core/types";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type FindingsResponse, api } from "../api/client";
import { type NodeScope, inScope } from "../graph/scope";
import { useNodeScope } from "../graph/useNodeScope";
import { msg, t, useT } from "../i18n";
import { formatCount, IO_LABELS, languageColor } from "../ui/visual";
import { useAppStore } from "../store/useAppStore";
import { ChangesBody } from "./ChangesPanel";
import { ResizablePanelHandle, useResizablePanel } from "./ResizablePanelHandle";
import { TabStrip } from "./TabStrip";

/**
 * 结构树。
 *
 * 覆盖在画布之上而不是挤压画布——布局抖动会让用户丢失在图上的视觉焦点，
 * 这个代价比多占一点空间大得多。
 */
export function TreePanel() {
  const t = useT();
  const open = useAppStore((s) => s.treeOpen);
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const setTreeOpen = useAppStore((s) => s.setTreeOpen);
  const tab = useAppStore((s) => s.panelTab);
  const setTab = useAppStore((s) => s.setPanelTab);
  // 图上聚焦到哪个节点，体检、入口、变更就只列它里面的
  const focus = useNodeScope(useAppStore((s) => s.focus));
  const resize = useResizablePanel({
    side: "left",
    visible: open,
    storageKey: "repolens:left-panel-custom-width",
    fallbackWidth: 300,
    minWidth: 180,
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
        label={t("调整左侧边栏宽度")}
        width={resize.width}
        minWidth={resize.minWidth}
        maxWidth={resize.maxWidth}
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onReset={resize.reset}
      />
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] px-3">
        <TabStrip scrollKey={tab}>
          <PanelTab active={tab === "tree"} onClick={() => setTab("tree")} label={t("结构")} />
          <PanelTab active={tab === "findings"} onClick={() => setTab("findings")} label={t("体检")} />
          <PanelTab active={tab === "entries"} onClick={() => setTab("entries")} label={t("入口")} />
          <PanelTab active={tab === "changes"} onClick={() => setTab("changes")} label={t("变更")} />
        </TabStrip>
        <button
          type="button"
          onClick={() => setTreeOpen(false)}
          className="shrink-0 text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        >
          ×
        </button>
      </div>

      {tab !== "tree" && focus && <FocusScopeBar scope={focus} />}
      {tab === "tree" ? (
        <TreeBody key={`tree:${repoId ?? ""}:${repoRevision}`} />
      ) : tab === "findings" ? (
        <FindingsBody key={`findings:${repoId ?? ""}:${repoRevision}`} scope={focus} />
      ) : tab === "changes" ? (
        <ChangesBody key={`changes:${repoId ?? ""}:${repoRevision}`} scope={focus} />
      ) : (
        <EntriesBody key={`entries:${repoId ?? ""}:${repoRevision}`} scope={focus} />
      )}
    </aside>
  );
}

function FocusScopeBar({ scope }: { scope: NodeScope }) {
  const t = useT();
  const setFocus = useAppStore((s) => s.setFocus);
  return (
    <button
      type="button"
      onClick={() => setFocus(null)}
      title={t("取消聚焦，列出全部")}
      className="mx-3 mt-2 flex shrink-0 items-center gap-1.5 rounded bg-[var(--color-accent)]/12 px-2 py-1 text-left text-[10.5px] text-[var(--color-accent)] transition-colors hover:bg-[var(--color-accent)]/20"
    >
      <span className="min-w-0 flex-1 truncate">{t("只看聚焦的 {name} 里的", { name: scope.label })}</span>
      <span className="shrink-0 text-[12px] leading-none">×</span>
    </button>
  );
}

/**
 * 入口清单。点一个入口就从它的处理函数开始单步走读；服务端已按「能走到多远」排好序，
 * 往下走不到别的函数的入口（只调库、或匿名闭包没有独立符号）收在最后。
 */
function EntriesBody({ scope }: { scope: NodeScope | null }) {
  const t = useT();
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const showNoise = useAppStore((s) => s.showNoise);
  const openWalk = useAppStore((s) => s.openWalk);
  const active = useAppStore((s) => s.walk?.stack[0]?.id ?? null);
  const [entries, setEntries] = useState<EntryPointDto[] | null>(null);
  const [query, setQuery] = useState("");
  const [showShallow, setShowShallow] = useState(false);

  // 面板按仓库 key，换仓库就是新实例；索引刷新时原地重取，不清空列表
  useEffect(() => {
    let stale = false;
    void api.entries().then((value) => { if (!stale) setEntries(value); }).catch(() => { if (!stale) setEntries([]); });
    return () => { stale = true; };
  }, [repoId, repoRevision, indexRevision]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (entries ?? []).filter((entry) =>
      (showNoise || (entry.kind !== "test" && entry.fileRole !== "test")) &&
      (scope === null || inScope(scope, entry.filePath, entry.symbolId ?? null)) &&
      (needle === "" || entry.label.toLowerCase().includes(needle) || entry.filePath.toLowerCase().includes(needle)));
  }, [entries, showNoise, scope, query]);
  const deep = visible.filter((entry) => entry.symbolId && entry.reachSymbols > 0);
  const shallow = visible.filter((entry) => !(entry.symbolId && entry.reachSymbols > 0));
  // 十几个都叫 main 的入口光看名字分不出来，重名的把所在包和文件写在名字后面
  const packages = useAppStore((s) => s.overview?.packages);
  const duplicated = useMemo(() => {
    const counts = new Map<string, number>();
    for (const entry of visible) counts.set(entry.label, (counts.get(entry.label) ?? 0) + 1);
    return new Set([...counts].filter(([, n]) => n > 1).map(([label]) => label));
  }, [visible]);
  const locationOf = (entry: EntryPointDto) =>
    duplicated.has(entry.label) ? entryLocation(entry.filePath, packages ?? []) : null;

  if (entries === null) return <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">{t("加载中…")}</div>;
  if (entries.length === 0) return (
    <div className="px-3 py-4 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
      {t("没有识别到入口。重新扫描后可识别 main、HTTP 路由、CLI、公共 API 与测试入口。")}
    </div>
  );

  const row = (entry: EntryPointDto) => (
    <EntryRow key={entry.id} entry={entry} active={entry.symbolId === active} location={locationOf(entry)}
      onOpen={() => entry.symbolId && openWalk(entry.symbolId, entry.label)} />
  );

  return (
    <>
      <div className="shrink-0 px-3 pt-2">
        <div className="text-[10.5px] text-[var(--color-ink-faint)]">{t("从入口开始单步走读 · 越往下走得远的越靠前")}</div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("筛选入口或文件")}
          className="mt-1.5 w-full rounded border border-[var(--color-line)] bg-[var(--color-canvas)] px-2 py-1 text-[11px] text-[var(--color-ink)] outline-none placeholder:text-[var(--color-ink-faint)] focus:border-[var(--color-accent)]/60"
        />
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto py-1">
        {deep.map(row)}
        {deep.length === 0 && (
          <div className="px-3 py-3 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
            {query
              ? t("没有匹配的入口。")
              : scope && shallow.length === 0
                ? t("{name} 里没有入口。", { name: scope.label })
                : t("没有入口能沿静态调用关系走到仓库里的其他函数。")}
          </div>
        )}
        {shallow.length > 0 && (
          <div className="mt-1 border-t border-[var(--color-line)]/60 pt-1">
            <button
              type="button"
              onClick={() => setShowShallow((value) => !value)}
              aria-expanded={showShallow}
              className="flex w-full items-center px-3 py-1.5 text-left text-[10.5px] text-[var(--color-ink-faint)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-ink-muted)]"
            >
              <span>{t("走不到其他函数的入口")}</span>
              <span className="ml-auto tabular-nums">{shallow.length}</span>
              <span className="ml-2 w-6 text-right">{showShallow ? t("收起") : t("显示")}</span>
            </button>
            {showShallow && shallow.map(row)}
          </div>
        )}
      </div>
    </>
  );
}

function EntryRow({ entry, active, location, onOpen }: {
  entry: EntryPointDto;
  active: boolean;
  /** 和别的入口重名时才有：所在包和文件 */
  location: string | null;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onOpen}
      disabled={!entry.symbolId}
      title={entry.symbolId ? `${entry.filePath}:${entry.line}` : t("处理函数没有独立符号，无法走读")}
      className={`block w-full px-3 py-1.5 text-left transition-colors enabled:hover:bg-[var(--color-surface-raised)] disabled:cursor-default disabled:opacity-60 ${
        active ? "bg-[var(--color-surface-3)]" : ""
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="shrink-0 rounded border border-[var(--color-line)] px-1 text-[9px] uppercase text-[var(--color-accent)]">
          {entryKindLabel(entry.kind)}
        </span>
        <span className={`${location ? "shrink-0" : "min-w-0 flex-1"} truncate text-[11.5px]`}>{entry.label}</span>
        {location && (
          <span className="mono min-w-0 flex-1 truncate-start truncate text-[10px] text-[var(--color-ink-faint)]">{location}</span>
        )}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 pl-0.5 text-[9.5px] text-[var(--color-ink-faint)]">
        {entry.reachSymbols > 0 ? (
          <span className="tabular-nums">
            {t("{count} 个函数", { count: entry.reachSymbols >= 999 ? "999+" : entry.reachSymbols })}
            {entry.reachFiles > 0 ? ` · ${t("跨 {count} 个文件", { count: entry.reachFiles })}` : ""}
          </span>
        ) : (
          <span className="mono truncate">{entry.filePath.split("/").at(-1)}:{entry.line}</span>
        )}
        {entry.reachIo.map((kind) => (
          <span key={kind} className="rounded border border-[var(--color-warn)]/30 px-1 text-[var(--color-warn)]">
            {t(IO_LABELS[kind])}
          </span>
        ))}
      </div>
    </button>
  );
}

/** 包内相对路径前面带上包的短名：`coding-agent · src/main.ts` */
function entryLocation(filePath: string, packages: ReadonlyArray<{ name: string; dir: string }>): string {
  let owner: { name: string; dir: string } | null = null;
  for (const pkg of packages) {
    if (pkg.dir === "." || !filePath.startsWith(`${pkg.dir}/`)) continue;
    if (!owner || pkg.dir.length > owner.dir.length) owner = pkg;
  }
  if (!owner) return filePath;
  const short = owner.name.includes("/") ? owner.name.slice(owner.name.lastIndexOf("/") + 1) : owner.name;
  return `${short} · ${filePath.slice(owner.dir.length + 1)}`;
}

function entryKindLabel(kind: EntryPointDto["kind"]): string {
  return ({ main: "main", cli: "cli", http: "http", "public-api": "api", test: "test" })[kind];
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
      aria-pressed={active}
      onClick={onClick}
      className={`shrink-0 rounded px-2 py-0.5 text-[12px] transition-colors ${
        active
          ? "bg-[var(--color-surface-raised)] font-medium text-[var(--color-ink)]"
          : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
      }`}
    >
      {label}
    </button>
  );
}

/**
 * 结构树列出仓库里的全部文件，不跟噪音开关走：画布回答「主干是什么」，
 * 结构树回答「仓库里有什么」。不参与分析的置灰，点开照样能看源码。
 *
 * 和画布双向联动：图上选中什么，树就一路展开到它所在的文件或目录并滚过去；
 * 树上点一项，图上也展开到它并居中。
 */
function TreeBody() {
  const t = useT();
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const select = useAppStore((s) => s.select);
  const selected = useAppStore((s) => s.selected);
  const [root, setRoot] = useState<TreeNodeDto | null>(null);
  const target = useNodeScope(selected)?.path ?? null;
  const rootSelected = root !== null && (selected === root.id || target === root.path);

  useEffect(() => {
    let cancelled = false;
    setRoot(null);
    void api
      .files(".")
      .then((tree) => {
        if (!cancelled) setRoot(tree);
      })
      .catch(() => {
        if (!cancelled) setRoot(null);
      });
    return () => {
      cancelled = true;
    };
  }, [repoId, repoRevision]);

  return (
    <>
      {/* 仓库根在画布上没有节点，仓库级的 AI 概览和根目录 README 从这里进 */}
      {root && (
        <button
          type="button"
          onClick={() => select(root.id)}
          title={t("查看仓库概览和 README")}
          className={`flex shrink-0 items-center gap-1.5 border-b border-[var(--color-line)] px-3 py-1.5 text-left text-[12px] transition-colors ${
            rootSelected ? "bg-[var(--color-surface-3)]" : "hover:bg-[var(--color-surface-2)]"
          }`}
        >
          <FolderIcon open />
          <span className="truncate font-medium text-[var(--color-ink)]">{root.name}</span>
          <span className="ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
            {formatCount(root.loc)}
          </span>
        </button>
      )}
      <div className="shrink-0 px-3 pt-2 text-[10.5px] text-[var(--color-ink-faint)]">
        {t("按代码行热力排序 · 灰色的不参与分析")}
      </div>
      <div className="thin-scroll flex-1 overflow-y-auto py-1">
        {root === null ? (
          <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">{t("加载中…")}</div>
        ) : (
          (root.children ?? []).map((child) => <TreeRow key={child.id} node={child} depth={0} target={target} />)
        )}
      </div>
    </>
  );
}

const ROLE_LABELS: Record<FileRole, string> = {
  source: msg("源码"),
  test: msg("测试"),
  config: msg("配置"),
  generated: msg("生成代码"),
  types: msg("类型声明"),
  docs: msg("文档"),
  asset: msg("资源文件"),
  vendor: msg("第三方代码"),
};

const EXCLUSION_HINTS: Record<ExclusionReason, string> = {
  builtin: msg("依赖或构建目录，固定不扫描"),
  ignored: msg("被 .gitignore、.repolensignore 或 exclude 规则排除"),
  vendor: msg("第三方代码，不扫描"),
  "too-large": msg("文件超过扫描大小上限"),
  symlink: msg("软链接，不跟随"),
  unscanned: msg("上次扫描之后新增，重新扫描后纳入"),
};

function statusHint(node: TreeNodeDto): string | undefined {
  if (node.status === "excluded") {
    return t("没进索引：{reason}", { reason: t(EXCLUSION_HINTS[node.excludedBy ?? "unscanned"]) });
  }
  if (node.status !== "noise") return undefined;
  return node.role ? t("不参与分析：{role}", { role: t(ROLE_LABELS[node.role]) }) : t("目录里没有参与分析的源码");
}

/** target 是图上选中项落在的路径（符号取所在文件），树据此一层层展开到它 */
function TreeRow({ node, depth, target }: { node: TreeNodeDto; depth: number; target: string | null }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const locate = useAppStore((s) => s.locate);
  const openDetail = useAppStore((s) => s.openDetail);
  // 画布上包和目录是两种节点，目录正好是某个包的根时，图上只有那个包
  const packageId = useAppStore((s) =>
    node.kind === "directory" ? s.overview?.packages.find((p) => p.dir === node.path)?.id ?? null : null);
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<TreeNodeDto[] | null>(node.children ?? null);
  const [loading, setLoading] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const muted = node.status === "noise" || node.status === "excluded";
  const isTarget = target === node.path;
  const holdsTarget = node.kind === "directory" && target !== null && target.startsWith(`${node.path}/`);

  const load = useCallback(async () => {
    if (children !== null) return;
    setLoading(true);
    try {
      const sub = await api.files(node.path);
      setChildren(sub.children ?? []);
    } finally {
      setLoading(false);
    }
  }, [children, node.path]);

  const toggle = useCallback(async () => {
    if (node.kind === "file") return;
    if (expanded) {
      setExpanded(false);
      return;
    }
    setExpanded(true);
    await load();
  }, [expanded, load, node.kind]);

  useEffect(() => {
    if (!holdsTarget) return;
    setExpanded(true);
    if (!loading) void load();
  }, [holdsTarget, target, load, loading]);

  useEffect(() => {
    if (isTarget) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [isTarget]);

  // 灰色目录不在画布上、没有概览可看，单击直接展开；灰色文件直接看源码
  const open = () => {
    if (muted && node.kind === "directory") void toggle();
    else if (node.status === "noise") openDetail(node.id, { tab: "source", lines: null }, false);
    else if (node.status === "excluded") select(node.id);
    else locate(packageId ?? node.id);
  };

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        aria-expanded={node.kind === "directory" ? expanded : undefined}
        tabIndex={0}
        title={statusHint(node)}
        onClick={open}
        onDoubleClick={muted ? undefined : () => void toggle()}
        onKeyDown={(event) => {
          if (event.key === "Enter") open();
          if (event.key === " ") {
            event.preventDefault();
            void toggle();
          }
        }}
        className={`group relative flex cursor-pointer items-center gap-1.5 py-[3px] pr-3 text-[12px] transition-colors ${
          isTarget ? "bg-[var(--color-surface-3)]" : "hover:bg-[var(--color-surface-2)]"
        } ${node.status === "excluded" ? "opacity-60" : ""}`}
        style={{ paddingLeft: 13 + depth * 13 }}
      >
        {/* 热力条：宽度即该项在同级中的相对体量，不占额外的行 */}
        {!muted && (
          <span
            className="pointer-events-none absolute inset-y-0 left-0 bg-[var(--color-accent)]/8"
            style={{ width: `${Math.max(2, node.heat * 100)}%` }}
          />
        )}

        {node.kind === "directory" ? (
          <FolderIcon open={expanded} muted={muted} />
        ) : (
          <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden="true">
            <span
              className="h-1.5 w-1.5 rounded-full"
              style={{ background: languageColor(node.language), opacity: muted ? 0.4 : 1 }}
            />
          </span>
        )}

        <span className={`relative truncate ${muted ? "text-[var(--color-ink-faint)]" : "text-[var(--color-ink)]"}`}>
          {node.name}
        </span>

        {(!muted || node.loc > 0) && (
          <span className="relative ml-auto shrink-0 tabular-nums text-[10px] text-[var(--color-ink-faint)]">
            {formatCount(node.loc)}
          </span>
        )}
      </div>

      {expanded && loading && (
        <div
          className="py-1 text-[10.5px] text-[var(--color-ink-faint)]"
          style={{ paddingLeft: 26 + depth * 13 }}
        >
          {t("加载中…")}
        </div>
      )}

      {expanded && children?.map((child) => (
        <TreeRow key={child.id} node={child} depth={depth + 1} target={target} />
      ))}
    </>
  );
}

/**
 * 目录使用明确的文件夹图标，而不是中性圆点。圆点在结构树中只表示文件语言，
 * 避免用户把目录的灰点误解成一种语言；文件夹自身的开合形态表达展开状态。
 */
function FolderIcon({ open, muted = false }: { open: boolean; muted?: boolean }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`relative h-3.5 w-3.5 shrink-0 ${muted ? "text-[var(--color-ink-faint)]" : "text-[var(--color-ink-muted)]"}`}
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
function FindingsBody({ scope }: { scope: NodeScope | null }) {
  const t = useT();
  const repoId = useAppStore((s) => s.repoId);
  const repoRevision = useAppStore((s) => s.repoRevision);
  const indexRevision = useAppStore((s) => s.indexRevision);
  const [data, setData] = useState<FindingsResponse | null>(null);
  const [kind, setKind] = useState<"all" | FindingKind>("all");
  const reveal = useAppStore((s) => s.reveal);
  const selected = useAppStore((s) => s.selected);
  const scopeId = scope?.id;
  const query = `${kind}:${scopeId ?? ""}`;
  const lastQuery = useRef(query);

  useEffect(() => {
    let cancelled = false;
    // 换了筛选才清空；索引刷新时旧列表留着，等新的到了再换
    if (lastQuery.current !== query) setData(null);
    lastQuery.current = query;
    void api
      .findings(kind === "all" ? undefined : kind, scopeId)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [kind, scopeId, query, repoId, repoRevision, indexRevision]);

  if (data === null) {
    return <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">{t("加载中…")}</div>;
  }

  if (data.summary.total === 0 && scope) {
    return (
      <div className="px-3 py-4 text-[11.5px] text-[var(--color-ink-faint)]">
        {t("{name} 里没有体检问题。", { name: scope.label })}
      </div>
    );
  }

  if (data.summary.total === 0) {
    return (
      <div className="px-3 py-4 text-[11.5px] leading-relaxed text-[var(--color-ink-faint)]">
        {t("没有发现结构问题。")}
        <br />
        {t("当前检查项：跨文件的重复实现、循环依赖、读不动的过大函数和文件、.repolens.json 里的依赖规则和分层、依赖锁之外的新依赖、绕过包入口的引用、总是一起改却没有依赖的文件、指向已删除文件的文档。")}
      </div>
    );
  }

  return (
    <>
      <div className="flex shrink-0 flex-wrap items-center gap-1 px-3 pt-2">
        <FilterChip active={kind === "all"} onClick={() => setKind("all")}>
          {t("全部 {count}", { count: data.summary.total })}
        </FilterChip>
        {FINDING_FILTERS.filter((filter) => (data.summary.byKind[filter.kind] ?? 0) > 0 || kind === filter.kind).map((filter) => (
          <FilterChip key={filter.kind} active={kind === filter.kind} onClick={() => setKind(filter.kind)}>
            {t(filter.label, { count: data.summary.byKind[filter.kind] ?? 0 })}
          </FilterChip>
        ))}
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
              {(item.recentCommits ?? 0) > 0 && (
                <span
                  className="ml-auto shrink-0 text-[9.5px] tabular-nums"
                  style={{ color: (item.recentCommits ?? 0) >= 3 ? "var(--color-warn)" : "var(--color-ink-faint)" }}
                  title={t("所在文件近 90 天改过 {count} 次：改得勤的地方先修", { count: item.recentCommits ?? 0 })}
                >
                  {t("近 90 天 {count} 次", { count: item.recentCommits ?? 0 })}
                </span>
              )}
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

/** 取值要在渲染时过 t() */
const FINDING_FILTERS: ReadonlyArray<{ kind: FindingKind; label: string }> = [
  { kind: "violation", label: msg("违规 {count}") },
  { kind: "layering", label: msg("分层倒置 {count}") },
  { kind: "unapproved", label: msg("未批准依赖 {count}") },
  { kind: "cycle", label: msg("循环 {count}") },
  { kind: "bypass", label: msg("绕过入口 {count}") },
  { kind: "duplicate", label: msg("重复 {count}") },
  { kind: "oversized", label: msg("过大 {count}") },
  { kind: "coupling", label: msg("隐性耦合 {count}") },
  { kind: "stale-doc", label: msg("文档过期 {count}") },
];

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
