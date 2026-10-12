import type { UnderstandingCountsDto, UnderstandingMarkDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { useUnderstandingStore } from "../store/useUnderstandingStore";
import { Label, LinkButton, RatioBar, RowButton, percent } from "../ui/panel";

const STALE_SHOWN = 5;

/**
 * 入口页签顶上的理解账本：主干看懂了几成、哪些看懂后又被改过。账本按内容指纹记，代码一改就过期——
 * AI 改过的地方，得重新看过才算数。每个入口那条调用链看懂了多少，画在入口那一行上（FlowProgress）。
 */
export function UnderstandingSummary() {
  const t = useT();
  const ledger = useUnderstandingStore((s) => s.ledger);
  const status = useUnderstandingStore((s) => s.status);
  const error = useUnderstandingStore((s) => s.error);

  useEffect(() => {
    void useUnderstandingStore.getState().load();
  }, []);

  if (status === "error") return <div className="px-3 pt-2 text-[11px] text-[var(--color-warn)]">{error}</div>;
  if (!ledger) return null;

  const { key, all, marks } = ledger.summary;
  // 认不出主入口的仓库没有主干，只能看全部函数
  const main = key.total > 0 ? key : all;
  const coverage = (counts: UnderstandingCountsDto) =>
    t("{understood}/{total} · {share}", { understood: counts.understood, total: counts.total, share: percent(counts.understood, counts.total) });

  return (
    <section className="border-b border-[var(--color-line)]/60 px-3 pb-2.5 pt-2">
      <Label>{t("我的理解")}</Label>
      <div
        className="mt-1.5 flex items-baseline gap-2 text-[11px]"
        title={main === key ? t("从 HTTP、命令行、main 和公共 API 入口沿调用走得到的函数：系统真正在跑的那部分") : undefined}
      >
        <span className="text-[var(--color-ink)]">{main === key ? t("主干") : t("全部函数")}</span>
        <span className="ml-auto tabular-nums text-[var(--color-ink-muted)]">{coverage(main)}</span>
      </div>
      <div className="mt-1">
        <RatioBar value={main.understood} total={main.total} stale={main.stale} />
      </div>
      {marks === 0 ? (
        <p className="mt-1 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
          {t("还没有标记。读懂一个函数、文件或模块的接口后点「我看懂了」，代码改了会提醒你重新看。")}
        </p>
      ) : main === key && (
        <p
          className="mt-1 flex gap-2 text-[10px] text-[var(--color-ink-faint)]"
          title={t("共 {count} 条标记，存在 .repolens/understanding.json，只记在你本机。", { count: marks })}
        >
          <span>{t("全部函数")}</span>
          <span className="ml-auto tabular-nums">{coverage(all)}</span>
        </p>
      )}
      {ledger.stale.length > 0 && <StaleList marks={ledger.stale} />}
    </section>
  );
}

/** 入口那一行上的一小截：这条调用链看懂了几成，看懂后又被改过的那截标黄 */
export function FlowProgress({ counts }: { counts: UnderstandingCountsDto }) {
  const t = useT();
  const params = { understood: counts.understood, total: counts.total, stale: counts.stale };
  return (
    <span
      className="ml-auto flex shrink-0 items-center gap-1 text-[10px]"
      title={counts.stale > 0
        ? t("这条调用链上看懂了 {understood}/{total} 个函数，{stale} 个看懂后又被改过", params)
        : t("这条调用链上看懂了 {understood}/{total} 个函数", params)}
    >
      <span className="w-10">
        <RatioBar value={counts.understood} total={counts.total} stale={counts.stale} />
      </span>
      <span className="tabular-nums" style={{ color: counts.stale > 0 ? "var(--color-warn)" : "var(--color-success)" }}>
        {percent(counts.understood, counts.total)}
      </span>
    </span>
  );
}

function StaleList({ marks }: { marks: UnderstandingMarkDto[] }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? marks : marks.slice(0, STALE_SHOWN);
  return (
    <div className="mt-2.5">
      <div className="text-[10px] text-[var(--color-warn)]">{t("看懂后又被改过 ({count})", { count: marks.length })}</div>
      <div className="mt-0.5">
        {shown.map((mark) => (
          <div key={mark.key} className="flex items-center gap-1">
            <RowButton onClick={mark.nodeId ? () => select(mark.nodeId!) : undefined} meta={mark.path.split("/").at(-1)} title={mark.path}>
              <span className="mono truncate text-[11px] text-[var(--color-ink)]">{mark.label}</span>
            </RowButton>
            {mark.nodeId && (
              <LinkButton onClick={() => void useUnderstandingStore.getState().mark(mark.nodeId!, mark.how)} title={t("重新看过了，按现在的代码重新记")}>
                {t("重新看过")}
              </LinkButton>
            )}
          </div>
        ))}
      </div>
      {marks.length > STALE_SHOWN && (
        <div className="px-1.5 pt-0.5">
          <LinkButton tone="muted" onClick={() => setExpanded(!expanded)}>
            {expanded ? t("收起") : t("还有 {count} 个", { count: marks.length - STALE_SHOWN })}
          </LinkButton>
        </div>
      )}
    </div>
  );
}
