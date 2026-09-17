import type {
  FileDetailDto,
  SourceSliceDto,
  SymbolDetailDto,
} from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { formatCount, languageColor, symbolGlyph } from "../lib/visual";
import { useAppStore } from "../store/useAppStore";

type Tab = "overview" | "params" | "pseudocode" | "source" | "relations";

const TAB_LABELS: Record<Tab, string> = {
  overview: "概览",
  params: "传参",
  pseudocode: "伪代码",
  source: "源码",
  relations: "关系",
};

/**
 * 右侧详情抽屉。
 *
 * 分标签页是「隐藏」策略的直接落地：默认只加载概览，源码和关系
 * 这类重查询等到用户点开对应标签才发请求。
 */
export function DetailDrawer() {
  const open = useAppStore((s) => s.drawerOpen);
  const selected = useAppStore((s) => s.selected);
  const setDrawerOpen = useAppStore((s) => s.setDrawerOpen);
  const [tab, setTab] = useState<Tab>("overview");

  useEffect(() => {
    setTab("overview");
  }, [selected]);

  if (!open || selected === null) return null;

  const isSymbol = selected.startsWith("sym:");
  const isFile = selected.startsWith("file:");
  const availableTabs: Tab[] = isSymbol
    ? ["overview", "params", "pseudocode", "source", "relations"]
    : isFile
      ? ["overview", "source", "relations"]
      : ["overview"];

  return (
    <aside className="anim-slide-right absolute right-0 top-0 z-30 flex h-full w-[400px] flex-col border-l border-[var(--color-line)] bg-[var(--color-surface)]/95 backdrop-blur">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b border-[var(--color-line)] pl-3 pr-2">
        {availableTabs.map((key) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`rounded px-2 py-1 text-[11.5px] transition-colors ${
              tab === key
                ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]"
                : "text-[var(--color-ink-faint)] hover:text-[var(--color-ink-muted)]"
            }`}
          >
            {TAB_LABELS[key]}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setDrawerOpen(false)}
          className="ml-auto px-1 text-[13px] text-[var(--color-ink-faint)] hover:text-[var(--color-ink)]"
        >
          ×
        </button>
      </div>

      <div className="thin-scroll flex-1 overflow-y-auto">
        {isSymbol && <SymbolBody key={selected} id={selected} tab={tab} />}
        {isFile && <FileBody key={selected} id={selected} tab={tab} />}
        {!isSymbol && !isFile && <ScopeBody id={selected} />}
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// 符号
// ---------------------------------------------------------------------------

function SymbolBody({ id, tab }: { id: string; tab: Tab }) {
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
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const generateSemantics = () => {
    if (semanticLoading) return;
    setSemanticLoading(true);
    setSemanticError(null);
    void api
      .generateSymbolSemantics(id)
      .then((result) => {
        setDetail((current) =>
          current?.id === id
            ? { ...current, summary: result.summary, pseudocode: result.pseudocode ?? null }
            : current,
        );
      })
      .catch((e: Error) => setSemanticError(e.message))
      .finally(() => setSemanticLoading(false));
  };

  // 严格按需：只有用户真的切到伪代码标签才发模型请求。
  useEffect(() => {
    if (tab !== "pseudocode" || detail === null || detail.pseudocode || semanticLoading || semanticError) return;
    generateSemantics();
  }, [tab, detail, semanticLoading, semanticError]);

  if (error) return <Empty>{error}</Empty>;
  if (!detail) return <Skeleton />;

  if (tab === "params") {
    return (
      <div className="p-3">
        {detail.params.length === 0 ? (
          <Empty>这个符号没有参数</Empty>
        ) : (
          <table className="w-full text-[11.5px]">
            <thead>
              <tr className="text-left text-[var(--color-ink-faint)]">
                <th className="pb-1.5 font-normal">参数</th>
                <th className="pb-1.5 font-normal">类型</th>
                <th className="pb-1.5 font-normal">默认值</th>
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
            <Label>返回</Label>
            <div className="mono mt-1 text-[11.5px] text-[var(--color-accent)]">
              {detail.returnType}
            </div>
          </div>
        )}
      </div>
    );
  }

  if (tab === "pseudocode") {
    return (
      <div className="p-3">
        <div className="mb-2 text-[9.5px] uppercase tracking-wider text-[var(--color-accent)]">
          AI 生成 · 可能不准确
        </div>
        {detail.pseudocode ? (
          <pre className="mono whitespace-pre-wrap rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2.5 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.pseudocode}
          </pre>
        ) : semanticLoading ? (
          <SemanticLoading label="正在理解这个符号并生成伪代码…" />
        ) : semanticError ? (
          <div>
            <Empty>{semanticError}</Empty>
            <RetryButton onClick={generateSemantics}>重新生成</RetryButton>
          </div>
        ) : (
          <Empty>
            当前索引里还没有这个符号的伪代码。
          </Empty>
        )}
      </div>
    );
  }

  if (tab === "source") {
    return <SourceView fileId={detail.fileId} from={detail.startLine} to={detail.endLine} />;
  }

  if (tab === "relations") {
    return (
      <div className="p-3">
        <CallGraphButton detail={detail} />
        <RelationList title="调用它的" items={detail.callers} />
        <RelationList title="它调用的" items={detail.callees} />

        {detail.externalCallees.length > 0 && (
          <div className="mt-3">
            <Label>外部调用</Label>
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
            <Empty>没有解析出调用关系。可能它只被动态调用，或者调用方都在索引范围之外。</Empty>
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
          <Label>文档注释</Label>
          <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.doc}
          </p>
        </div>
      )}

      {detail.summary ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <Label ai>AI 摘要</Label>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.summary}
          </p>
        </div>
      ) : semanticLoading ? (
        <SemanticLoading label="正在生成函数摘要与伪代码…" />
      ) : semanticError ? (
        <div className="mt-2">
          <div className="text-[11px] text-[var(--color-warn)]">{semanticError}</div>
          <RetryButton onClick={generateSemantics}>重试</RetryButton>
        </div>
      ) : (
        <RetryButton onClick={generateSemantics}>生成 AI 摘要与伪代码</RetryButton>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label="行数" value={String(detail.endLine - detail.startLine + 1)} />
        <Metric label="复杂度" value={String(detail.complexity)} />
        <Metric label="种类" value={detail.kind} />
      </div>

      {detail.typeRelations.length > 0 && (
        <div className="mt-3">
          <Label>类型关系</Label>
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
      在画布上展开调用图
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
  const styles: Record<string, string> = {
    exact: "border-[var(--color-accent)]/40 text-[var(--color-accent)]",
    likely: "border-[var(--color-warn)]/40 text-[var(--color-warn)]",
    ambiguous: "border-[var(--color-line-strong)] text-[var(--color-ink-faint)]",
    external: "border-[var(--color-line)] text-[var(--color-ink-faint)]",
    unresolved: "border-[var(--color-line)] text-[var(--color-ink-faint)]",
  };
  const labels: Record<string, string> = {
    exact: "确定",
    likely: "可能",
    ambiguous: "多义",
    external: "外部",
    unresolved: "未解析",
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

function FileBody({ id, tab }: { id: string; tab: Tab }) {
  const select = useAppStore((s) => s.select);
  const [detail, setDetail] = useState<FileDetailDto | null>(null);
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
      .file(id)
      .then((d) => !cancelled && setDetail(d))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  const generateSummary = () => {
    if (semanticLoading) return;
    setSemanticLoading(true);
    setSemanticError(null);
    void api
      .generateFileSummary(id)
      .then((result) =>
        setDetail((current) => (current?.id === id ? { ...current, summary: result.summary } : current)),
      )
      .catch((e: Error) => setSemanticError(e.message))
      .finally(() => setSemanticLoading(false));
  };

  if (error) return <Empty>{error}</Empty>;
  if (!detail) return <Skeleton />;

  if (tab === "source") return <SourceView fileId={detail.id} />;

  if (tab === "relations") {
    return (
      <div className="p-3">
        <Label>依赖 ({detail.imports.length})</Label>
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
          <Label>被依赖 ({detail.importedBy.length})</Label>
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

      {detail.summary ? (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <Label ai>AI 摘要</Label>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">
            {detail.summary}
          </p>
        </div>
      ) : semanticLoading ? (
        <SemanticLoading label="正在生成文件摘要…" />
      ) : semanticError ? (
        <div className="mt-2">
          <div className="text-[11px] text-[var(--color-warn)]">{semanticError}</div>
          <RetryButton onClick={generateSummary}>重试</RetryButton>
        </div>
      ) : (
        <RetryButton onClick={generateSummary}>生成 AI 文件摘要</RetryButton>
      )}

      <div className="mt-3 grid grid-cols-3 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label="代码行" value={formatCount(detail.loc)} />
        <Metric label="符号" value={String(detail.symbols.length)} />
        <Metric label="依赖" value={String(detail.imports.length)} />
      </div>

      <div className="mt-3">
        <Label>符号 ({detail.symbols.length})</Label>
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
                <span className="shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">内部</span>
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

function ScopeBody({ id }: { id: string }) {
  const store = useAppStore();
  const graph = store.subgraphs[store.rootScope];
  const node =
    Object.values(store.subgraphs)
      .flatMap((g) => g.nodes)
      .find((n) => n.id === id) ?? graph?.nodes.find((n) => n.id === id);

  if (!node) return <Empty>找不到这个节点</Empty>;

  return (
    <div className="p-3">
      <div className="text-[14px] font-medium">{node.label}</div>
      {node.path && (
        <div className="mono mt-1 break-all text-[10.5px] text-[var(--color-ink-faint)]">
          {node.path}
        </div>
      )}

      {node.layer && (
        <div className="mt-2 text-[10px] text-[var(--color-accent)]">AI 架构层 · {node.layer}</div>
      )}
      {node.summary && (
        <div className="mt-2.5 rounded-md border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 p-2.5">
          <Label ai>AI 摘要</Label>
          <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">{node.summary}</p>
        </div>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2 border-t border-[var(--color-line)] pt-2.5">
        <Metric label="代码行" value={formatCount(node.metrics.loc)} />
        <Metric label="文件" value={formatCount(node.metrics.files)} />
        <Metric label="符号" value={formatCount(node.metrics.symbols)} />
        <Metric label="复杂度" value={formatCount(node.metrics.complexity)} />
        <Metric label="被依赖" value={String(node.metrics.inDegree)} />
        <Metric label="依赖" value={String(node.metrics.outDegree)} />
      </div>

      {node.expandable && (
        <button
          type="button"
          onClick={() => void store.toggleExpand(node)}
          className="mt-3 w-full rounded-md border border-[var(--color-line)] py-1.5 text-[11.5px] text-[var(--color-ink-muted)] transition-colors hover:border-[var(--color-line-strong)] hover:text-[var(--color-ink)]"
        >
          {store.expanded.includes(node.id) ? "收起子项" : `展开 ${node.childCount} 项`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 源码
// ---------------------------------------------------------------------------

function SourceView({ fileId, from, to }: { fileId: string; from?: number; to?: number }) {
  const [slice, setSlice] = useState<SourceSliceDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSlice(null);
    void api
      .source(fileId, from, to)
      .then((s) => !cancelled && setSlice(s))
      .catch((e: Error) => !cancelled && setError(e.message));
    return () => {
      cancelled = true;
    };
  }, [fileId, from, to]);

  if (error) return <Empty>{error}</Empty>;
  if (!slice) return <Skeleton />;

  const lines = slice.code.split("\n");

  return (
    <div className="thin-scroll overflow-x-auto p-3">
      <pre className="mono text-[11px] leading-[1.55]">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            <span className="w-10 shrink-0 select-none pr-2 text-right text-[var(--color-ink-faint)]">
              {slice.startLine + i}
            </span>
            <span className="whitespace-pre text-[var(--color-ink-muted)]">{line || " "}</span>
          </div>
        ))}
      </pre>
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
