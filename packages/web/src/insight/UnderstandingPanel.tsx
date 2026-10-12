import type { NextReadReason, TourDto, UnderstandingCountsDto, UnderstandingMarkDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { msg, useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";
import { useUnderstandingStore } from "../store/useUnderstandingStore";
import { Chip, LinkButton, RatioBar, RowButton, percent } from "../ui/panel";
import { TourPlayer, tourTitle } from "./TourPlayer";

/** 取值要在渲染时过 t() */
const REASON_LABELS: Record<NextReadReason, string> = {
  entry: msg("入口"),
  complex: msg("复杂"),
  hot: msg("改得勤"),
  central: msg("很多地方调"),
  untested: msg("没测试"),
  stale: msg("改过了"),
};

/**
 * 理解页签：人自己看懂了多少。账本按内容指纹记，代码一改就过期——AI 改过的地方，
 * 得重新看过才算数。下面是团队写下的阅读导览和「下一步读什么」。
 */
export function UnderstandingBody() {
  const t = useT();
  const ledger = useUnderstandingStore((s) => s.ledger);
  const status = useUnderstandingStore((s) => s.status);
  const error = useUnderstandingStore((s) => s.error);
  const [tours, setTours] = useState<TourDto[] | null>(null);
  const [playing, setPlaying] = useState<string | null>(null);
  const indexRevision = useAppStore((s) => s.indexRevision);

  useEffect(() => {
    void useUnderstandingStore.getState().load();
  }, []);

  const loadTours = () => api.tours().then((result) => setTours(result.tours)).catch(() => setTours([]));
  useEffect(() => {
    void loadTours();
  }, [indexRevision]);

  const active = tours?.find((tour) => tour.id === playing) ?? null;
  if (active) {
    return (
      <div className="thin-scroll flex-1 overflow-y-auto">
        <TourPlayer
          tour={active}
          onClose={() => setPlaying(null)}
          onSaved={(saved) => {
            void loadTours().then(() => setPlaying(saved?.id ?? null));
          }}
        />
      </div>
    );
  }

  return (
    <div className="thin-scroll flex-1 overflow-y-auto px-3 pb-4 pt-2">
      {status === "error" && <div className="text-[11px] text-[var(--color-warn)]">{error}</div>}
      {ledger ? (
        <>
          <Coverage title={t("主干")} hint={t("从 HTTP、命令行、main 和公共 API 入口沿调用走得到的函数：系统真正在跑的那部分")} counts={ledger.summary.key} />
          <Coverage title={t("全部函数")} counts={ledger.summary.all} />
          <p className="mt-1.5 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
            {ledger.summary.marks === 0
              ? t("还没有标记。读懂一个函数、文件或模块的接口后点「我看懂了」，代码改了会提醒你重新看。")
              : t("共 {count} 条标记，存在 .repolens/understanding.json，只记在你本机。", { count: ledger.summary.marks })}
          </p>
        </>
      ) : (
        <div className="py-2 text-[11px] text-[var(--color-ink-faint)]">{t("加载中…")}</div>
      )}

      <Tours tours={tours} onPlay={setPlaying} />
      {ledger && ledger.stale.length > 0 && <StaleList marks={ledger.stale} />}
      {ledger && <NextReads items={ledger.next} />}
    </div>
  );
}

function Coverage({ title, hint, counts }: { title: string; hint?: string; counts: UnderstandingCountsDto }) {
  const t = useT();
  return (
    <div className="mt-2" title={hint}>
      <div className="flex items-baseline gap-2 text-[11px]">
        <span className="text-[var(--color-ink)]">{title}</span>
        <span className="ml-auto tabular-nums text-[var(--color-ink-muted)]">
          {t("{understood}/{total} · {share}", { understood: counts.understood, total: counts.total, share: percent(counts.understood, counts.total) })}
        </span>
      </div>
      <div className="mt-1">
        <RatioBar value={counts.understood} total={counts.total} stale={counts.stale} />
      </div>
      {counts.stale > 0 && (
        <div className="mt-0.5 text-[10px] text-[var(--color-warn)]">{t("{count} 个看懂后又被改过", { count: counts.stale })}</div>
      )}
    </div>
  );
}

function Tours({ tours, onPlay }: { tours: TourDto[] | null; onPlay: (id: string) => void }) {
  const t = useT();
  return (
    <section className="mt-4">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{t("阅读导览")}</div>
      {tours === null ? (
        <div className="py-1 text-[11px] text-[var(--color-ink-faint)]">{t("加载中…")}</div>
      ) : (
        <div className="mt-1 space-y-0.5">
          {tours.map((tour) => (
            <RowButton key={tour.id} onClick={() => onPlay(tour.id)} meta={t("{count} 步", { count: tour.steps.length })}>
              <span className="truncate text-[11.5px] text-[var(--color-ink)]">{tourTitle(tour)}</span>
              {tour.generated ? <Chip tone="accent">{t("自动")}</Chip> : <Chip tone="success">{t("团队")}</Chip>}
            </RowButton>
          ))}
          <p className="pt-1 text-[10.5px] leading-relaxed text-[var(--color-ink-faint)]">
            {t("自动生成的导览按入口、核心类型、分层和热点排好；改过、加上说明后保存，就写进 .repolens.json 随代码提交。")}
          </p>
        </div>
      )}
    </section>
  );
}

function StaleList({ marks }: { marks: UnderstandingMarkDto[] }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  return (
    <section className="mt-4">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-warn)]">{t("看懂后又被改过 ({count})", { count: marks.length })}</div>
      <div className="mt-1 space-y-0.5">
        {marks.map((mark) => (
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
    </section>
  );
}

function NextReads({ items }: { items: Array<{ id: string; name: string; path: string; line: number; complexity: number; callers: number; recentCommits: number; reasons: NextReadReason[] }> }) {
  const t = useT();
  const openWalk = useAppStore((s) => s.openWalk);
  const select = useAppStore((s) => s.select);
  if (items.length === 0) {
    return (
      <section className="mt-4">
        <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{t("下一步读什么")}</div>
        <p className="mt-1 text-[11px] text-[var(--color-success)]">{t("主干上的函数都看过了。")}</p>
      </section>
    );
  }
  return (
    <section className="mt-4">
      <div className="text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{t("下一步读什么")}</div>
      <div className="mt-1 space-y-1">
        {items.map((item) => (
          <div key={item.id} className="rounded px-1.5 py-1 transition-colors hover:bg-[var(--color-surface-2)]">
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => openWalk(item.id, item.name)}
                title={t("从这里开始单步走读")}
                className="mono min-w-0 truncate text-left text-[11.5px] text-[var(--color-ink)] hover:text-[var(--color-accent)]"
              >
                {item.name}
              </button>
              <span className="ml-auto shrink-0">
                <LinkButton onClick={() => select(item.id)} tone="muted">{t("详情")}</LinkButton>
              </span>
            </div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1">
              {item.reasons.map((reason) => (
                <Chip key={reason} tone={reason === "stale" ? "warn" : reason === "untested" ? "danger" : "neutral"}>
                  {t(REASON_LABELS[reason])}
                </Chip>
              ))}
              <span className="mono truncate text-[10px] text-[var(--color-ink-faint)]">{item.path.split("/").at(-1)}:{item.line}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

