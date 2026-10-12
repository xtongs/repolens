import type { FileHistoryDto } from "@repolens/core/types";
import { intlLocale, useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { Chip, Metric, RowButton, Section } from "../ui/panel";

/**
 * 文件的改动历史：改得勤不勤、多少次有 AI 参与，以及总和它一起改的文件。
 * 一起改却没有依赖关系的，说明两边藏着代码里看不出来的约定。
 */
export function HistorySection({ history }: { history: FileHistoryDto | null | undefined }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  if (!history) return null;

  const last = history.lastChangedAt
    ? new Date(history.lastChangedAt).toLocaleDateString(intlLocale(), { year: "numeric", month: "short", day: "numeric" })
    : null;

  return (
    <Section title={t("改动历史（近一年）")} aside={last ? <span className="text-[10px] text-[var(--color-ink-faint)]">{t("最近 {date}", { date: last })}</span> : undefined}>
      <div className="grid grid-cols-4 gap-2">
        <Metric label={t("提交")} value={String(history.commits)} />
        <Metric label={t("近 90 天")} value={String(history.recentCommits)} tone={history.recentCommits >= 5 ? "warn" : undefined} />
        <Metric label={t("作者")} value={String(history.authors)} />
        <Metric label={t("AI 参与")} value={String(history.aiCommits)} />
      </div>
      {history.coChanged.length > 0 && (
        <div className="mt-2">
          <div className="text-[10.5px] text-[var(--color-ink-faint)]">{t("常和它一起改的文件")}</div>
          <div className="mt-1 space-y-0.5">
            {history.coChanged.map((item) => (
              <RowButton
                key={item.path}
                onClick={item.id ? () => select(item.id!) : undefined}
                meta={t("{count} 次", { count: item.together })}
                title={item.linked ? undefined : t("两者在代码里没有直接依赖，却总是一起改：可能藏着隐性约定")}
              >
                <span className="mono truncate text-[11px] text-[var(--color-ink-muted)]">{item.path}</span>
                {!item.linked && <Chip tone="warn">{t("无依赖")}</Chip>}
              </RowButton>
            ))}
          </div>
        </div>
      )}
    </Section>
  );
}
