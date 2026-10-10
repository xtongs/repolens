import type { ChangeReportDto, DependencyChangeDto, FileChangeDto, SymbolChangeDto } from "@repolens/core/types";
import { useEffect, useMemo, useState } from "react";
import { type NodeScope, inScope } from "../graph/scope";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { useChangesStore } from "../store/useChangesStore";

const MARK = { added: "+", removed: "−", modified: "~", moved: "›", affected: "~", resolved: "✓" } as const;
const MARK_COLOR = {
  added: "var(--color-success)",
  removed: "var(--color-danger)",
  modified: "var(--color-accent)",
  moved: "var(--color-ink-muted)",
  affected: "var(--color-warn)",
  resolved: "var(--color-success)",
} as const;

/**
 * 变更视角：和某个提交比，这次改动在结构上意味着什么。
 *
 * 排序按审阅的先后：先看新增了哪些模块依赖和外部库（架构有没有被悄悄改掉），
 * 再看哪些入口会走到改过的代码（影响面），最后才是逐文件的符号清单。
 */
export function ChangesBody({ scope }: { scope: NodeScope | null }) {
  const t = useT();
  const status = useChangesStore((s) => s.status);
  const report = useChangesStore((s) => s.report);
  const error = useChangesStore((s) => s.error);
  const base = useChangesStore((s) => s.base);
  const compare = useChangesStore((s) => s.compare);
  const [draft, setDraft] = useState(base);

  useEffect(() => {
    if (status === "idle") void compare();
  }, [status, compare]);

  return (
    <>
      <form
        className="flex shrink-0 items-center gap-1.5 px-3 pt-2"
        onSubmit={(event) => {
          event.preventDefault();
          void compare(draft);
        }}
      >
        <span className="shrink-0 text-[10.5px] text-[var(--color-ink-faint)]">{t("对比")}</span>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          spellCheck={false}
          aria-label={t("基线提交")}
          placeholder="HEAD"
          className="mono min-w-0 flex-1 rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] px-1.5 py-0.5 text-[11px] text-[var(--color-ink)] outline-none focus:border-[var(--color-accent)]"
        />
        <button
          type="submit"
          disabled={status === "loading"}
          className="shrink-0 rounded border border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-ink-muted)] hover:border-[var(--color-line-strong)] disabled:opacity-50"
        >
          {status === "loading" ? t("对比中…") : t("对比")}
        </button>
      </form>

      {status === "loading" && !report && (
        <Hint>{t("正在为基线提交建立结构索引，第一次对比某个提交需要几秒。")}</Hint>
      )}
      {status === "error" && <Hint tone="danger">{error}</Hint>}
      {report && <ReportView full={report} scope={scope} />}
    </>
  );
}

/**
 * 只留落在聚焦节点里的改动。入口除了自己在里面，走到里面改动的也留着——
 * 「这块改了会波及哪些入口」正是聚焦时想看的影响面。外部库是整仓的，聚焦时不列。
 */
function scopeReport(report: ChangeReportDto, scope: NodeScope): ChangeReportDto {
  const symbolPath = new Map(report.symbols.flatMap((s) => (s.id ? [[s.id, s.path] as const] : [])));
  const reaches = (id: string) => {
    const path = symbolPath.get(id);
    return path !== undefined && inScope(scope, path, id);
  };
  return {
    ...report,
    files: report.files.filter((file) => inScope(scope, file.path)),
    symbols: report.symbols.filter((symbol) => inScope(scope, symbol.path, symbol.id)),
    dependencies: report.dependencies.filter((dep) => dependencyInScope(dep, scope)),
    externals: { added: [], removed: [] },
    findings: report.findings.filter((finding) => inScope(scope, finding.path, finding.scopeKey)),
    entries: report.entries.filter((entry) =>
      inScope(scope, entry.path, entry.symbolId) || entry.via.some((v) => reaches(v.id))),
  };
}

/** 依赖边只在包和目录这两级有，聚焦到文件或符号时没有能对上的 */
function dependencyInScope(dep: DependencyChangeDto, scope: NodeScope): boolean {
  if (scope.kind === "package" && dep.level === "package") {
    const name = scope.id.slice("pkg:".length);
    return dep.source === name || dep.target === name;
  }
  if (scope.kind === "package" || scope.kind === "directory") {
    return dep.level === "directory" && (inScope(scope, dep.source) || inScope(scope, dep.target));
  }
  return false;
}

function ReportView({ full, scope }: { full: ChangeReportDto; scope: NodeScope | null }) {
  const t = useT();
  const report = useMemo(() => (scope ? scopeReport(full, scope) : full), [full, scope]);
  const showNoise = useAppStore((s) => s.showNoise);
  const files = useMemo(
    () => report.files.filter((file) => showNoise || file.role === "source"),
    [report.files, showNoise],
  );
  const symbols = useMemo(
    () => report.symbols.filter((symbol) => showNoise || symbol.role === "source"),
    [report.symbols, showNoise],
  );
  const exported = symbols.filter((symbol) => symbol.exported);
  const hidden = report.files.length - files.length;
  const indexedAt = report.headIndexedAt ? new Date(report.headIndexedAt).toLocaleString() : null;

  return (
    <div className="thin-scroll flex-1 overflow-y-auto pb-3">
      <div className="px-3 pt-1.5 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
        <span className="mono">{report.base.ref} · {report.base.commit.slice(0, 8)}</span>
        {" → "}
        {report.head
          ? <span className="mono">{report.head.ref} · {report.head.commit.slice(0, 8)}</span>
          : t("上次扫描时的代码")}
        {!report.head && indexedAt && <span> ({indexedAt})</span>}
      </div>

      {full.files.length === 0 ? (
        <Hint>{t("和基线相比没有结构变化。改完代码后重新扫描再对比。")}</Hint>
      ) : scope && report.files.length === 0 && report.entries.length === 0 && report.dependencies.length === 0 ? (
        <Hint>{t("{name} 里没有改动。", { name: scope.label })}</Hint>
      ) : (
        <>
          <Summary report={report} files={files} symbols={symbols} />
          <DependencySection report={report} />
          <EntrySection report={report} />
          <FindingSection report={report} />
          <Section title={t("对外接口变化")} count={exported.length}>
            {exported.map((symbol) => <SymbolRow key={`${symbol.path}:${symbol.name}:${symbol.line}:${symbol.status}`} symbol={symbol} showPath />)}
          </Section>
          <FileSection files={files} symbols={symbols} />
          {hidden > 0 && (
            <Hint>{t("另有 {count} 个测试、配置等文件的改动未列出，打开「显示噪音」可见。", { count: hidden })}</Hint>
          )}
        </>
      )}
    </div>
  );
}

function Summary({ report, files, symbols }: { report: ChangeReportDto; files: FileChangeDto[]; symbols: SymbolChangeDto[] }) {
  const t = useT();
  const count = (status: SymbolChangeDto["status"]) => symbols.filter((s) => s.status === status).length;
  const added = report.dependencies.filter((d) => d.status === "added").length;
  const removed = report.dependencies.filter((d) => d.status === "removed").length;
  return (
    <div className="mx-3 mt-2 grid grid-cols-3 gap-1 text-center">
      <Stat label={t("改动文件")} value={String(files.length)} />
      <Stat label={t("改动符号")} value={`+${count("added")} ~${count("modified")} −${count("removed")}`} />
      <Stat label={t("依赖变化")} value={`+${added} −${removed}`} highlight={added > 0} />
    </div>
  );
}

function Stat({ label, value, highlight }: { label: string; value: string; highlight?: boolean }) {
  return (
    <div className="rounded border border-[var(--color-line)] px-1 py-1">
      <div className={`mono text-[11px] tabular-nums ${highlight ? "text-[var(--color-warn)]" : "text-[var(--color-ink)]"}`}>{value}</div>
      <div className="text-[9.5px] text-[var(--color-ink-faint)]">{label}</div>
    </div>
  );
}

function DependencySection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const { added, removed } = report.externals;
  const total = report.dependencies.length + added.length + removed.length;
  return (
    <Section title={t("模块依赖")} count={total}>
      {report.dependencies.map((dep) => (
        <Row
          key={`${dep.level}:${dep.type}:${dep.source}:${dep.target}:${dep.status}`}
          status={dep.status}
          onClick={() => void reveal(dep.level === "package" ? `pkg:${dep.source}` : `dir:${dep.source}`)}
          title={`${dep.source} → ${dep.target}`}
        >
          <span className="mono truncate-start truncate">{shortPath(dep.source)} → {shortPath(dep.target)}</span>
          <span className="ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">
            {dep.level === "package" ? t("包级") : ""}{dep.type === "references" ? t("仅类型") : dep.type === "http" ? "HTTP" : ""} {dep.count}
          </span>
        </Row>
      ))}
      {added.map((name) => (
        <Row key={`ext+${name}`} status="added"><span className="mono truncate">{name}</span><Tag>{t("外部库")}</Tag></Row>
      ))}
      {removed.map((name) => (
        <Row key={`ext-${name}`} status="removed"><span className="mono truncate">{name}</span><Tag>{t("外部库")}</Tag></Row>
      ))}
    </Section>
  );
}

function EntrySection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  return (
    <Section title={t("入口与影响面")} count={report.entries.length}>
      {report.entries.map((entry) => (
        <Row
          key={`${entry.status}:${entry.kind}:${entry.label}:${entry.path}`}
          status={entry.status}
          onClick={entry.symbolId ? () => void reveal(entry.symbolId as string) : undefined}
          title={entry.via.length > 0
            ? t("走到改动：{names}", { names: entry.via.map((v) => `${v.name} (${v.depth})`).join(", ") })
            : entry.path}
        >
          <span className="shrink-0 rounded border border-[var(--color-line)] px-1 text-[9px] uppercase text-[var(--color-accent)]">
            {entry.kind === "public-api" ? "api" : entry.kind}
          </span>
          <span className="truncate">{entry.label}</span>
          {entry.status === "affected" && (
            <span className="ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">
              {t("{count} 处改动", { count: entry.via.length })}
            </span>
          )}
        </Row>
      ))}
    </Section>
  );
}

function FindingSection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  return (
    <Section title={t("体检变化")} count={report.findings.length}>
      {report.findings.map((finding) => (
        <Row
          key={`${finding.status}:${finding.scopeKey}:${finding.title}`}
          status={finding.status}
          onClick={finding.status === "added" ? () => void reveal(finding.scopeKey) : undefined}
          title={finding.detail}
        >
          <span className="truncate">{finding.title}</span>
          <Tag>{finding.status === "added" ? t("新增") : t("消除")}</Tag>
        </Row>
      ))}
    </Section>
  );
}

function FileSection({ files, symbols }: { files: FileChangeDto[]; symbols: SymbolChangeDto[] }) {
  const t = useT();
  const [open, setOpen] = useState<string | null>(null);
  const reveal = useAppStore((s) => s.reveal);
  const byFile = useMemo(() => {
    const out = new Map<string, SymbolChangeDto[]>();
    for (const symbol of symbols) {
      const bucket = out.get(symbol.path);
      if (bucket) bucket.push(symbol); else out.set(symbol.path, [symbol]);
    }
    return out;
  }, [symbols]);

  return (
    <Section title={t("逐文件")} count={files.length}>
      {files.map((file) => {
        const changes = byFile.get(file.path) ?? [];
        const expanded = open === file.path;
        return (
          <div key={`${file.status}:${file.path}`}>
            <Row
              status={file.status}
              onClick={() => {
                setOpen(expanded ? null : file.path);
                if (file.id) void reveal(file.id);
              }}
              title={file.from ? t("从 {path} 移动而来", { path: file.from }) : file.path}
            >
              <span className="mono truncate-start truncate">{file.path}</span>
              {changes.length > 0 && (
                <span className="ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{changes.length}</span>
              )}
            </Row>
            {expanded && changes.map((symbol) => (
              <SymbolRow key={`${symbol.name}:${symbol.line}:${symbol.status}`} symbol={symbol} indent />
            ))}
          </div>
        );
      })}
    </Section>
  );
}

function SymbolRow({ symbol, showPath, indent }: { symbol: SymbolChangeDto; showPath?: boolean; indent?: boolean }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const name = symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name;
  const cosmetic = symbol.status === "modified" && !symbol.shapeChanged;
  const signatureChanged = symbol.status === "modified" && symbol.signature !== symbol.signatureBefore;
  const complexer = symbol.complexityBefore !== null && symbol.complexity - symbol.complexityBefore >= 5;
  return (
    <Row
      status={symbol.status}
      indent={indent}
      onClick={symbol.id ? () => void reveal(symbol.id as string) : undefined}
      title={[
        showPath ? `${symbol.path}:${symbol.line}` : null,
        signatureChanged ? `${symbol.signatureBefore ?? ""}\n→ ${symbol.signature ?? ""}` : symbol.signature,
        symbol.status === "removed" ? t("基线里有 {count} 个调用方", { count: symbol.callers }) : t("{count} 个调用方", { count: symbol.callers }),
      ].filter(Boolean).join("\n")}
    >
      <span className="mono truncate">{name}</span>
      {showPath && <span className="mono truncate text-[9.5px] text-[var(--color-ink-faint)]">{symbol.path.split("/").at(-1)}</span>}
      <span className="ml-auto flex shrink-0 gap-1">
        {signatureChanged && <Tag tone="warn">{t("签名")}</Tag>}
        {complexer && <Tag tone="warn">{`${symbol.complexityBefore}→${symbol.complexity}`}</Tag>}
        {cosmetic && <Tag>{t("仅格式")}</Tag>}
      </span>
    </Row>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: React.ReactNode }) {
  if (count === 0) return null;
  return (
    <div className="mt-3">
      <div className="flex items-center px-3 pb-1 text-[10.5px] font-medium text-[var(--color-ink-muted)]">
        {title}
        <span className="ml-auto tabular-nums text-[var(--color-ink-faint)]">{count}</span>
      </div>
      {children}
    </div>
  );
}

function Row({
  status, onClick, title, indent, children,
}: {
  status: keyof typeof MARK;
  onClick?: (() => void) | undefined;
  title?: string | undefined;
  indent?: boolean | undefined;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={!onClick}
      title={title}
      className="flex w-full items-center gap-1.5 py-[3px] pr-3 text-left text-[11.5px] text-[var(--color-ink)] enabled:hover:bg-[var(--color-surface-raised)] disabled:cursor-default"
      style={{ paddingLeft: indent ? 26 : 12 }}
    >
      <span className="mono w-2.5 shrink-0 text-center text-[11px]" style={{ color: MARK_COLOR[status] }}>{MARK[status]}</span>
      {children}
    </button>
  );
}

function Tag({ children, tone }: { children: React.ReactNode; tone?: "warn" }) {
  return (
    <span
      className="shrink-0 rounded px-1 text-[9px]"
      style={{
        color: tone === "warn" ? "var(--color-warn)" : "var(--color-ink-faint)",
        background: "var(--color-surface-2)",
      }}
    >
      {children}
    </span>
  );
}

function Hint({ children, tone }: { children: React.ReactNode; tone?: "danger" }) {
  return (
    <div
      className="px-3 py-3 text-[11px] leading-relaxed"
      style={{ color: tone === "danger" ? "var(--color-danger)" : "var(--color-ink-faint)" }}
    >
      {children}
    </div>
  );
}

function shortPath(path: string): string {
  const parts = path.split("/");
  return parts.length > 3 ? `…/${parts.slice(-2).join("/")}` : path;
}
