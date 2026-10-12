import type { TourDto, TourReasonDto, TourStepDto } from "@repolens/core/types";
import { useEffect, useState } from "react";
import { api } from "../api/client";
import { useNodeScope } from "../graph/useNodeScope";
import { t, useT } from "../i18n";
import { parseEdgeSelection } from "../lib/edge";
import { useAppStore } from "../store/useAppStore";
import { Chip, LinkButton } from "../ui/panel";
import { UnderstandButton } from "./UnderstandButton";

/** 调用它的组件自己用了 useT()，换语言时会跟着重新渲染 */
export function tourTitle(tour: TourDto): string {
  return tour.generated || tour.title === "" ? t("自动生成的阅读路径") : tour.title;
}

/**
 * 跟着导览一步步看：每一步定位到图上、打开详情，写着为什么在这里。
 * 可以改标题、加说明、调顺序、把当前选中的东西加进来，保存后写进 .repolens.json。
 */
export function TourPlayer({ tour, onClose, onSaved }: { tour: TourDto; onClose: () => void; onSaved: (saved: TourDto | null) => void }) {
  const t = useT();
  const [index, setIndex] = useState(0);
  const [editing, setEditing] = useState(false);
  const step = tour.steps[index] ?? null;

  // 换一步就带过去：图上展开到它、详情打开它
  useEffect(() => {
    if (step?.nodeId) void useAppStore.getState().reveal(step.nodeId);
  }, [step?.nodeId]);

  if (editing) {
    return <TourEditor tour={tour} onCancel={() => setEditing(false)} onSaved={(saved) => { setEditing(false); onSaved(saved); }} />;
  }

  return (
    <div className="px-3 pb-4 pt-2">
      <div className="flex items-center gap-1.5">
        <LinkButton onClick={onClose} tone="muted">← {t("全部导览")}</LinkButton>
        <span className="ml-auto">
          <LinkButton onClick={() => setEditing(true)}>{tour.generated ? t("改成团队导览…") : t("编辑")}</LinkButton>
        </span>
      </div>
      <div className="mt-2 text-[13px] font-medium text-[var(--color-ink)]">{tourTitle(tour)}</div>
      {tour.description && <p className="mt-1 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">{tour.description}</p>}

      {step ? (
        <div className="mt-3 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] p-2.5">
          <div className="flex items-center gap-2 text-[10px] text-[var(--color-ink-faint)]">
            <span className="tabular-nums">{t("第 {index}/{total} 步", { index: index + 1, total: tour.steps.length })}</span>
            <span className="mono ml-auto truncate">{stepTarget(step)}</span>
          </div>
          <div className="mt-1 text-[12.5px] font-medium text-[var(--color-ink)]">{step.title}</div>
          {step.reason && <p className="mt-1 text-[11px] text-[var(--color-accent)]">{reasonText(step.reason, t)}</p>}
          {step.note && <p className="mt-1 whitespace-pre-wrap text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">{step.note}</p>}
          {!step.nodeId && <p className="mt-1 text-[11px] text-[var(--color-warn)]">{t("这一步指向的代码已经不在了（被删或改名）")}</p>}
          <div className="mt-2 flex items-center gap-2">
            <button
              type="button"
              disabled={index === 0}
              onClick={() => setIndex(index - 1)}
              className="rounded border border-[var(--color-line)] px-2 py-0.5 text-[11px] text-[var(--color-ink-muted)] enabled:hover:border-[var(--color-line-strong)] disabled:opacity-40"
            >
              ← {t("上一步")}
            </button>
            <button
              type="button"
              disabled={index >= tour.steps.length - 1}
              onClick={() => setIndex(index + 1)}
              className="rounded bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-medium text-[var(--color-canvas)] disabled:opacity-40"
            >
              {t("下一步")} →
            </button>
            {step.nodeId && step.nodeId !== "dir:." && (
              <span className="ml-auto">
                <UnderstandButton nodeId={step.nodeId} how="tour" compact />
              </span>
            )}
          </div>
        </div>
      ) : (
        <p className="mt-3 text-[11px] text-[var(--color-ink-faint)]">{t("这条导览还没有步骤")}</p>
      )}

      <ol className="mt-3 space-y-0.5">
        {tour.steps.map((item, i) => (
          <li key={`${item.target}:${i}`}>
            <button
              type="button"
              onClick={() => setIndex(i)}
              className={`flex w-full items-baseline gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] transition-colors ${
                i === index ? "bg-[var(--color-surface-3)] text-[var(--color-ink)]" : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-2)]"
              }`}
            >
              <span className="w-4 shrink-0 tabular-nums text-[var(--color-ink-faint)]">{i + 1}</span>
              <span className={`truncate ${item.nodeId ? "" : "line-through opacity-60"}`}>{item.title}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

function TourEditor({ tour, onCancel, onSaved }: { tour: TourDto; onCancel: () => void; onSaved: (saved: TourDto | null) => void }) {
  const t = useT();
  const selected = useAppStore((s) => s.selected);
  const selectedLabel = useNodeScope(parseEdgeSelection(selected) ? null : selected)?.label;
  const [title, setTitle] = useState(tour.generated ? "" : tour.title);
  const [description, setDescription] = useState(tour.description ?? "");
  const [steps, setSteps] = useState<TourStepDto[]>(tour.steps.map((step) => ({ ...step, reason: null })));
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, change: Partial<TourStepDto>) =>
    setSteps((list) => list.map((step, i) => (i === index ? { ...step, ...change } : step)));
  const move = (index: number, delta: -1 | 1) =>
    setSteps((list) => {
      const next = [...list];
      const [item] = next.splice(index, 1);
      next.splice(index + delta, 0, item!);
      return next;
    });
  const canAdd = selected !== null && /^(?:pkg|dir|file|sym):./.test(selected) && parseEdgeSelection(selected) === null &&
    !steps.some((step) => step.nodeId === selected);
  const addSelected = () => {
    if (!canAdd || selected === null) return;
    setSteps((list) => [...list, { target: "", nodeId: selected, title: selectedLabel ?? labelOf(selected), note: null }]);
  };

  const save = () => {
    setBusy(true);
    setError(null);
    void api.saveTour({ id: tour.generated ? "" : tour.id, title: title.trim(), description: description.trim() || null, steps })
      .then((saved) => onSaved(saved))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };
  const remove = () => {
    setBusy(true);
    void api.deleteTour(tour.id)
      .then(() => onSaved(null))
      .catch((err: Error) => setError(err.message))
      .finally(() => setBusy(false));
  };

  const input = "w-full rounded border border-[var(--color-line)] bg-[var(--color-surface)] px-1.5 py-1 text-[11.5px] text-[var(--color-ink)] outline-none focus:border-[var(--color-line-strong)]";

  return (
    <div className="px-3 pb-4 pt-2">
      <div className="flex items-center gap-1.5">
        <LinkButton onClick={onCancel} tone="muted">← {t("取消")}</LinkButton>
        {!tour.generated && (
          <span className="ml-auto">
            {confirmDelete ? (
              <LinkButton onClick={remove} tone="warn" disabled={busy}>{t("确认删除")}</LinkButton>
            ) : (
              <LinkButton onClick={() => setConfirmDelete(true)} tone="muted">{t("删除导览")}</LinkButton>
            )}
          </span>
        )}
      </div>
      <label className="mt-2 block text-[10px] text-[var(--color-ink-faint)]">
        {t("标题")}
        <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("比如：新人第一天")} className={`${input} mt-0.5`} />
      </label>
      <label className="mt-1.5 block text-[10px] text-[var(--color-ink-faint)]">
        {t("说明")}
        <textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={2} className={`${input} mt-0.5 resize-y`} />
      </label>

      <div className="mt-2 space-y-1.5">
        {steps.map((step, index) => (
          <div key={`${step.target}:${step.nodeId ?? ""}:${index}`} className="rounded border border-[var(--color-line)] bg-[var(--color-surface-2)] p-1.5">
            <div className="flex items-center gap-1">
              <span className="w-4 shrink-0 text-[10px] tabular-nums text-[var(--color-ink-faint)]">{index + 1}</span>
              <input value={step.title} onChange={(event) => update(index, { title: event.target.value })} aria-label={t("这一步的标题")} className={`${input} py-0.5`} />
              <button type="button" disabled={index === 0} onClick={() => move(index, -1)} aria-label={t("上移")} className="px-0.5 text-[11px] text-[var(--color-ink-faint)] enabled:hover:text-[var(--color-ink)] disabled:opacity-30">↑</button>
              <button type="button" disabled={index === steps.length - 1} onClick={() => move(index, 1)} aria-label={t("下移")} className="px-0.5 text-[11px] text-[var(--color-ink-faint)] enabled:hover:text-[var(--color-ink)] disabled:opacity-30">↓</button>
              <button type="button" onClick={() => setSteps((list) => list.filter((_, i) => i !== index))} aria-label={t("删掉这一步")} className="px-0.5 text-[11px] text-[var(--color-ink-faint)] hover:text-[var(--color-danger)]">×</button>
            </div>
            <textarea
              value={step.note ?? ""}
              onChange={(event) => update(index, { note: event.target.value || null })}
              placeholder={t("写给读者：看这里时该注意什么")}
              rows={2}
              className={`${input} mt-1 resize-y text-[11px]`}
            />
          </div>
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <LinkButton onClick={addSelected} disabled={!canAdd} title={canAdd ? undefined : t("先在图上或结构树里选中一个函数、文件或模块")}>
          + {t("加入当前选中的")}
        </LinkButton>
        {selected && canAdd && <Chip>{selectedLabel ?? labelOf(selected)}</Chip>}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <button
          type="button"
          disabled={busy || title.trim() === "" || steps.length === 0}
          onClick={save}
          className="rounded bg-[var(--color-accent)] px-2.5 py-1 text-[11px] font-medium text-[var(--color-canvas)] disabled:opacity-50"
        >
          {busy ? t("保存中…") : t("保存到 .repolens.json")}
        </button>
        <span className="text-[10.5px] text-[var(--color-ink-faint)]">{t("随代码提交，团队里每个人看到的是同一条")}</span>
      </div>
      {error && <div className="mt-1.5 text-[11px] text-[var(--color-warn)]">{error}</div>}
    </div>
  );
}

function reasonText(reason: TourReasonDto, t: ReturnType<typeof useT>): string {
  switch (reason.kind) {
    case "overview":
      return t("先看仓库自述和整体结构");
    case "entry":
      return t("入口：往下走得到 {count} 个函数", { count: reason.count ?? 0 });
    case "type":
      return t("核心数据结构：{count} 个函数的签名里用到它", { count: reason.count ?? 0 });
    case "module":
      return reason.extra !== undefined
        ? t("模块：属于「{layer}」层，{count} 个模块依赖它", { layer: String(reason.extra), count: reason.count ?? 0 })
        : t("模块：{count} 个模块依赖它", { count: reason.count ?? 0 });
    case "hotspot":
      return t("热点：近 90 天改过 {count} 次，复杂度 {complexity}", { count: reason.count ?? 0, complexity: String(reason.extra ?? "") });
  }
}

function stepTarget(step: TourStepDto): string {
  return step.target.replace(/^(?:symbol|path):/, "");
}

function labelOf(nodeId: string): string {
  const rest = nodeId.replace(/^(?:pkg|dir|file|sym):/, "");
  return rest.split("/").at(-1) ?? rest;
}
