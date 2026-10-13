import type { GraphNodeDto } from "@repolens/core/types";
import { useT } from "../../i18n";
import { useAppStore } from "../../store/useAppStore";
import { useLensStore } from "../../store/useLensStore";
import { ratioWidth } from "../../ui/panel";

/**
 * 视角叠加层：节点底边一条细条。「测试覆盖」画测到了几成，「改动热度」按近 90 天的提交数
 * 相对最热的节点画长度。条只表达比例，具体数字放在 title 里，图上不铺字。
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
  if (total === 0) return null;
  const covered = value.covered ?? 0;
  return (
    <span className={`${position} flex overflow-hidden bg-[var(--color-surface-3)]`} title={t("测试走到 {covered}/{total} 个函数", { covered, total })}>
      <span style={{ width: ratioWidth(covered, total), background: "var(--color-accent)" }} />
    </span>
  );
}

/** 越热越红：冷的地方几乎不着色，免得满图都是警告色 */
function heatColor(share: number): string {
  const mix = Math.round(35 + share * 65);
  return `color-mix(in srgb, var(--color-danger) ${mix}%, var(--color-warn))`;
}
