import type { GraphNodeDto, LensValueDto } from "@repolens/core/types";
import { useT } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import { useLensStore } from "../../store/useLensStore";
import { ratioWidth } from "../../ui/panel";

/**
 * 视角叠加层：节点底边一条细条。「我的理解」画看懂了几成（改过的那截标黄），「测试覆盖」
 * 画测到了几成，「改动热度」按近 90 天的提交数相对最热的节点画长度。条只表达比例，
 * 具体数字放在 title 里，图上不铺字。
 */
export function LensBar({ dto, container = false }: { dto: GraphNodeDto; container?: boolean }) {
  const t = useT();
  const kind = useAppStore((s) => s.lens);
  const value = useLensStore((s) => s.values[dto.id]);
  const maxRecent = useLensStore((s) => s.maxRecent);
  if (kind === null || !value) return null;

  const position = container
    ? "absolute left-3 right-3 top-0 h-[3px] rounded-b"
    : "absolute bottom-0 left-[3px] right-0 h-[3px]";

  if (kind === "heat") {
    const recent = value.recent ?? 0;
    if ((value.commits ?? 0) === 0) return null;
    const share = maxRecent > 0 ? recent / maxRecent : 0;
    return (
      <span
        className={`${position} overflow-hidden bg-[var(--color-surface-3)]`}
        title={t("近 90 天 {recent} 次提交 · 近一年 {commits} 次 · AI 参与 {ai} 次", {
          recent, commits: value.commits ?? 0, ai: value.aiCommits ?? 0,
        })}
      >
        <span className="block h-full" style={{ width: `${Math.max(share * 100, recent > 0 ? 6 : 0)}%`, background: heatColor(share) }} />
      </span>
    );
  }

  const total = value.total ?? 0;
  const done = kind === "tests" ? value.covered ?? 0 : value.understood ?? 0;
  const stale = kind === "understanding" ? value.stale ?? 0 : 0;
  const title = kind === "tests"
    ? t("测试走到 {covered}/{total} 个函数", { covered: done, total })
    : t("看懂了 {understood}/{total} 个函数，{stale} 个看懂后又被改过", { understood: done, total, stale });

  return (
    <>
      {total > 0 && (
        <span className={`${position} flex overflow-hidden bg-[var(--color-surface-3)]`} title={title}>
          <span style={{ width: ratioWidth(done, total), background: kind === "tests" ? "var(--color-accent)" : "var(--color-success)" }} />
          {stale > 0 && <span style={{ width: ratioWidth(stale, total), background: "var(--color-warn)" }} />}
        </span>
      )}
      {kind === "understanding" && <MarkBadge value={value} container={container} />}
    </>
  );
}

function MarkBadge({ value, container }: { value: LensValueDto; container: boolean }) {
  const t = useT();
  if (!value.mark || container) return null;
  const understood = value.mark === "understood";
  return (
    <span
      className="absolute bottom-1 right-1.5 text-[10px] font-medium"
      style={{ color: understood ? "var(--color-success)" : "var(--color-warn)" }}
      title={understood ? t("你标过看懂了") : t("看懂之后又被改过")}
    >
      {understood ? "✓" : "↻"}
    </span>
  );
}

/** 越热越红：冷的地方几乎不着色，免得满图都是警告色 */
function heatColor(share: number): string {
  const mix = Math.round(35 + share * 65);
  return `color-mix(in srgb, var(--color-danger) ${mix}%, var(--color-warn))`;
}
