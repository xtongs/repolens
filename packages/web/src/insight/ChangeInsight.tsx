import type { ChangeClusterDto, ChangeReportDto, ClusterReason, SymbolChangeDto } from "@repolens/core/types";
import { useEffect, useMemo, useState } from "react";
import { msg, useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { useUnderstandingStore } from "../store/useUnderstandingStore";
import { ChangeRow, ChangeSection, ChangeTag } from "../ui/change-rows";
import { RatioBar } from "../ui/panel";
import { IO_LABELS } from "../ui/visual";

/** 取值要在渲染时过 t() */
const REASON_LABELS: Record<ClusterReason, string> = {
  exported: msg("对外接口"),
  signature: msg("签名变化"),
  io: msg("新 I/O"),
  calls: msg("新调用"),
  complexity: msg("复杂度上升"),
  untested: msg("没测试"),
  entries: msg("走到入口"),
};

/** 值得人过目的函数改动：新增的，或改了逻辑形状的；只改了命名和格式的不算 */
export function reviewableIds(symbols: readonly SymbolChangeDto[]): string[] {
  return symbols
    .filter((s) => s.id !== null && (s.kind === "function" || s.kind === "method") &&
      (s.status === "added" || (s.status === "modified" && s.shapeChanged)))
    .map((s) => s.id as string);
}

/** 这次改动里，人看过、记下「看懂了」的函数有几成；AI 再改一次，记下的就失效 */
export function ReviewProgress({ ids }: { ids: readonly string[] }) {
  const t = useT();
  const marks = useUnderstandingStore((s) => s.marks);
  const version = useUnderstandingStore((s) => s.version);
  const key = ids.join(",");

  useEffect(() => {
    if (ids.length > 0) void useUnderstandingStore.getState().track(ids);
    // ids 每次渲染都是新数组，按内容比较
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, version]);

  if (ids.length === 0) return null;
  const reviewed = ids.filter((id) => marks[id]?.mark === "understood").length;
  return (
    <div className="mx-3 mt-2" title={t("在改动单元里点「看过了」，或在详情里点「我看懂了」；之后再被改，就回到没看过")}>
      <div className="flex items-baseline text-[10.5px]">
        <span className="text-[var(--color-ink-muted)]">{t("看过的函数改动")}</span>
        <span className="ml-auto tabular-nums" style={{ color: reviewed === ids.length ? "var(--color-success)" : "var(--color-ink-faint)" }}>
          {reviewed}/{ids.length}
        </span>
      </div>
      <div className="mt-1">
        <RatioBar value={reviewed} total={ids.length} />
      </div>
    </div>
  );
}

/**
 * 改动单元：沿调用关系连在一起的一组改动，一次审一个概念。风险高的排前面——
 * 动了对外接口、开始碰新的 I/O、没有测试兜着的，最该先看。
 */
export function ClusterSection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const byId = useMemo(() => new Map(report.symbols.flatMap((s) => (s.id ? [[s.id, s] as const] : []))), [report.symbols]);
  if (report.clusters.length <= 1 && (report.clusters[0]?.members.length ?? 0) <= 1) return null;
  return (
    <ChangeSection
      title={t("改动单元")}
      count={report.clusters.length}
      hint={t("沿调用关系把改动归成组：一组就是一件事。风险高的在前")}
    >
      {report.clusters.map((cluster) => <ClusterRow key={cluster.id} cluster={cluster} byId={byId} />)}
    </ChangeSection>
  );
}

function ClusterRow({ cluster, byId }: { cluster: ChangeClusterDto; byId: ReadonlyMap<string, SymbolChangeDto> }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const marks = useUnderstandingStore((s) => s.marks);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const members = cluster.members.map((id) => byId.get(id)).filter((s): s is SymbolChangeDto => s !== undefined);
  const reviewable = reviewableIds(members);
  const pending = reviewable.filter((id) => marks[id]?.mark !== "understood");
  const tone = cluster.risk >= 12 ? "danger" : cluster.risk >= 6 ? "warn" : undefined;

  const markReviewed = () => {
    setBusy(true);
    const store = useUnderstandingStore.getState();
    void pending.reduce((chain, id) => chain.then(() => store.mark(id, "review")), Promise.resolve())
      .catch(() => undefined)
      .finally(() => setBusy(false));
  };

  return (
    <div>
      <div className="flex items-start gap-1 pr-3">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          title={t("风险 {risk}：{count} 处改动", { risk: cluster.risk, count: members.length })}
          className="min-w-0 flex-1 py-[3px] pl-3 text-left text-[11.5px] text-[var(--color-ink)] hover:bg-[var(--color-surface-raised)]"
        >
          <span className="flex items-center gap-1.5">
            <span className="w-2.5 shrink-0 text-center text-[9px] text-[var(--color-ink-faint)]">{open ? "▾" : "▸"}</span>
            <span
              className="mono shrink-0 rounded px-1 text-[9.5px] tabular-nums"
              style={{
                color: tone ? `var(--color-${tone})` : "var(--color-ink-faint)",
                background: tone ? `color-mix(in srgb, var(--color-${tone}) 14%, transparent)` : "var(--color-surface-2)",
              }}
            >
              {cluster.risk}
            </span>
            <span className="mono min-w-0 truncate">{cluster.label}</span>
            {members.length > 1 && <span className="shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">+{members.length - 1}</span>}
          </span>
          {cluster.reasons.length > 0 && (
            <span className="mt-0.5 flex flex-wrap gap-1 pl-4">
              {cluster.reasons.map((reason) => (
                <ChangeTag key={reason.kind} tone={reason.kind === "io" || reason.kind === "untested" ? "warn" : undefined}>
                  {t(REASON_LABELS[reason.kind])}{reason.count > 1 ? ` ×${reason.count}` : ""}
                </ChangeTag>
              ))}
            </span>
          )}
        </button>
        {reviewable.length > 0 && (
          pending.length === 0 ? (
            <span className="mt-[3px] shrink-0 text-[10px] text-[var(--color-success)]" title={t("这一组的函数都看过了")}>✓</span>
          ) : (
            <button
              type="button"
              disabled={busy}
              onClick={markReviewed}
              title={t("记下这一组改动你都看过了；之后再被改会重新提醒")}
              className="mt-[3px] shrink-0 rounded border border-[var(--color-line)] px-1 text-[9.5px] text-[var(--color-ink-faint)] hover:border-[var(--color-success)] hover:text-[var(--color-success)] disabled:opacity-50"
            >
              {t("看过了")}
            </button>
          )
        )}
      </div>
      {open && members.map((symbol) => (
        <ChangeRow
          key={symbol.id ?? `${symbol.path}:${symbol.name}`}
          status={symbol.status}
          indent
          onClick={symbol.id ? () => void reveal(symbol.id as string) : undefined}
          title={`${symbol.path}:${symbol.line}`}
        >
          <span className="mono truncate">{symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name}</span>
          {symbol.id && marks[symbol.id]?.mark === "understood" && <span className="text-[10px] text-[var(--color-success)]">✓</span>}
          <span className="mono ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{symbol.path.split("/").at(-1)}</span>
        </ChangeRow>
      ))}
    </div>
  );
}

/** 行为变化：函数新调了谁、不再调谁、开始碰哪类 I/O。行数变化说明不了这些 */
export function BehaviorSection({ report }: { report: ChangeReportDto }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  return (
    <ChangeSection title={t("行为变化")} count={report.behavior.length} hint={t("新调了谁、开始碰哪类 I/O：比行数更能说明这次改动做了什么")}>
      {report.behavior.map((change) => {
        const added = change.callsAdded.map((call) => (call.external ? `${call.external}.${call.name}` : call.name));
        const removed = change.callsRemoved.map((call) => (call.external ? `${call.external}.${call.name}` : call.name));
        return (
          <ChangeRow
            key={`${change.path}:${change.name}:${change.line}`}
            status={change.status}
            onClick={change.id ? () => void reveal(change.id as string) : undefined}
            title={[
              added.length > 0 ? t("新调 {names}", { names: added.join(", ") }) : "",
              removed.length > 0 ? t("不再调 {names}", { names: removed.join(", ") }) : "",
            ].filter(Boolean).join("\n")}
          >
            <span className="mono shrink-0">{change.name}</span>
            <span className="min-w-0 truncate text-[10px] text-[var(--color-ink-faint)]">
              {added.length > 0 && <>{t("新调")} <span className="mono text-[var(--color-ink-muted)]">{added.slice(0, 3).join(", ")}{added.length > 3 ? "…" : ""}</span></>}
              {added.length > 0 && removed.length > 0 && " · "}
              {removed.length > 0 && <>{t("不再调")} <span className="mono">{removed.slice(0, 2).join(", ")}{removed.length > 2 ? "…" : ""}</span></>}
            </span>
            <span className="ml-auto flex shrink-0 gap-1">
              {change.ioAdded.map((kind) => <ChangeTag key={`+${kind}`} tone="warn">{t("新碰 {io}", { io: t(IO_LABELS[kind]) })}</ChangeTag>)}
              {change.ioRemoved.map((kind) => <ChangeTag key={`-${kind}`}>{t("不再碰 {io}", { io: t(IO_LABELS[kind]) })}</ChangeTag>)}
            </span>
          </ChangeRow>
        );
      })}
    </ChangeSection>
  );
}

/** 改了逻辑、却没有任何测试走得到的函数：回归只能靠人眼 */
export function UntestedSection({ symbols }: { symbols: readonly SymbolChangeDto[] }) {
  const t = useT();
  const reveal = useAppStore((s) => s.reveal);
  const untested = symbols.filter((s) =>
    s.id !== null && s.status !== "removed" && s.tests === 0 && (s.kind === "function" || s.kind === "method") &&
    (s.status === "added" || s.shapeChanged));
  return (
    <ChangeSection title={t("改了但没有测试走到")} count={untested.length} hint={t("沿调用关系静态推算：没有任何测试用例走得到这些函数")}>
      {untested.map((symbol) => (
        <ChangeRow
          key={symbol.id as string}
          status={symbol.status}
          onClick={() => void reveal(symbol.id as string)}
          title={`${symbol.path}:${symbol.line}`}
        >
          <span className="mono truncate">{symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name}</span>
          <span className="mono ml-auto shrink-0 text-[9.5px] text-[var(--color-ink-faint)]">{symbol.path.split("/").at(-1)}</span>
        </ChangeRow>
      ))}
    </ChangeSection>
  );
}
