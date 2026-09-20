import type { TraceDto, TraceNarrativeDto, TraceStepDto } from "@repolens/core/types";
import { useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api/client";
import { useAppStore } from "../store/useAppStore";

const LANE = { entry: "入口", call: "内部调用", boundary: "I/O 边界" } as const;

/**
 * M4 使用独立的时序视图而不是复用依赖图：纵轴严格代表执行顺序，横向三条
 * 泳道代表步骤角色。颜色只表达证据来源，虚线/琥珀色永远表示静态推断。
 */
export function TraceView({ traceId }: { traceId: string }) {
  const repoId = useAppStore((s) => s.repoId);
  const reveal = useAppStore((s) => s.reveal);
  const [trace, setTrace] = useState<TraceDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let stale = false;
    setTrace(null);
    setError(null);
    void api.trace(traceId).then((value) => { if (!stale) setTrace(value); })
      .catch((err) => { if (!stale) setError((err as Error).message); });
    return () => { stale = true; };
  }, [traceId, repoId]);

  const narrativeByStep = useMemo(
    () => new Map(trace?.narrative?.steps.map((step) => [step.ordinal, step]) ?? []),
    [trace?.narrative],
  );

  const generate = async () => {
    setGenerating(true);
    setError(null);
    try {
      const result = await api.generateTraceNarrative(traceId);
      setTrace((current) => current ? { ...current, narrative: result.narrative, hasNarrative: true } : current);
    } catch (err) {
      setError(err instanceof ApiError && err.status === 503 ? "LLM 未配置，确定性链路仍可正常查看。" : (err as Error).message);
    } finally { setGenerating(false); }
  };

  if (error && trace === null) return <TraceState text={error} />;
  if (trace === null) return <TraceState text="正在装载链路…" />;

  return (
    <div className="thin-scroll h-full overflow-auto bg-[var(--color-canvas)]">
      <div className="mx-auto max-w-[1180px] px-8 py-7">
        <header className="mb-6 flex items-start gap-4">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <span className="rounded border border-[var(--color-accent)]/40 px-1.5 py-0.5 text-[9px] uppercase text-[var(--color-accent)]">
                {trace.entry.framework ?? trace.entry.kind}
              </span>
              <EvidenceBadge confidence={trace.confidence} />
            </div>
            <h1 className="text-[17px] font-medium text-[var(--color-ink)]">{trace.label}</h1>
            <p className="mono mt-1 text-[10.5px] text-[var(--color-ink-faint)]">
              {trace.entry.filePath}:{trace.entry.line} · {trace.steps} 个有序步骤
            </p>
          </div>
          <button type="button" disabled={generating} onClick={() => void generate()}
            className="rounded-md border border-[var(--color-accent)]/50 px-3 py-1.5 text-[11px] text-[var(--color-accent)] disabled:opacity-50">
            {generating ? "正在生成…" : trace.narrative ? "重新生成 AI 叙述" : "AI 解释链路"}
          </button>
        </header>

        {error && <div className="mb-4 rounded border border-[var(--color-warn)]/30 bg-[var(--color-warn)]/8 px-3 py-2 text-[11px] text-[var(--color-warn)]">{error}</div>}
        {trace.narrative && <Narrative value={trace.narrative} />}

        <div className="grid grid-cols-3 gap-4 border-b border-[var(--color-line)] pb-2 text-center text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">
          <span>入口</span><span>内部调用</span><span>I/O 边界</span>
        </div>

        <div className="relative py-3">
          <div className="absolute bottom-0 left-1/2 top-0 w-px bg-[var(--color-line)]" />
          {trace.orderedSteps.map((step, index) => (
            <StepRow key={`${step.ordinal}:${step.label}`} step={step} last={index === trace.orderedSteps.length - 1}
              narrative={narrativeByStep.get(step.ordinal)} onOpen={() => step.symbolId && void reveal(step.symbolId)} />
          ))}
        </div>

        <TypeFlows trace={trace} />
        <div className="mt-5 text-[10px] leading-relaxed text-[var(--color-ink-faint)]">
          绿色“确定”来自 AST 和精确调用链接；琥珀色“推断”来自唯一名/可见类型启发式。
          类型流仅按函数签名归纳，不代表运行时值或污点传播。
        </div>
      </div>
    </div>
  );
}

function StepRow({ step, last, narrative, onOpen }: {
  step: TraceStepDto; last: boolean; narrative?: TraceNarrativeDto["steps"][number]; onOpen: () => void;
}) {
  const column = step.kind === "entry" ? 1 : step.kind === "boundary" ? 3 : 2;
  return (
    <div className="relative grid min-h-[126px] grid-cols-3 gap-4">
      {!last && <span className="absolute left-1/2 top-[62px] h-[126px] border-l border-dashed border-[var(--color-line-strong)]" />}
      <span
        className="absolute left-1/2 top-[54px] z-10 h-4 w-4 -translate-x-1/2 rounded-full border-2 bg-[var(--color-canvas)]"
        style={{ borderColor: step.source === "deterministic" ? "var(--color-success)" : "var(--color-warn)" }}
      />
      <div className="min-w-0" style={{ gridColumn: column }}>
        <button type="button" onClick={onOpen} disabled={!step.symbolId}
          className={`w-full rounded-lg border bg-[var(--color-surface)] p-3 text-left transition-colors disabled:cursor-default ${step.source === "deterministic" ? "border-[var(--color-line)] hover:border-[var(--color-success)]/40" : "border-dashed border-[var(--color-warn)]/60 hover:border-[var(--color-warn)]"}`}>
          <div className="flex items-center gap-2">
            <span className="rounded bg-[var(--color-surface-3)] px-1.5 py-0.5 text-[9px] text-[var(--color-ink-faint)]">{step.ordinal + 1}</span>
            <span className="truncate text-[12px] font-medium">{step.label}</span>
            <EvidenceBadge confidence={step.confidence} />
          </div>
          <div className="mono mt-1.5 truncate text-[9.5px] text-[var(--color-ink-faint)]">
            定义 {step.filePath}:{step.line}
          </div>
          {step.callSite && (
            <div className="mono mt-0.5 truncate text-[9.5px] text-[var(--color-ink-faint)]">
              调用 {step.callSite.filePath}:{step.callSite.line} · {step.argCount} 个实参
            </div>
          )}
          {step.arguments.length > 0 && (
            <div className="mono mt-2 truncate rounded bg-[var(--color-canvas)]/70 px-2 py-1 text-[9.5px] text-[var(--color-ink-muted)]">
              args: {step.arguments.join(", ")}
            </div>
          )}
          {narrative && (
            <div className="mt-2 border-t border-[var(--color-line)] pt-2 text-[10.5px] leading-relaxed text-[var(--color-ink-muted)]">
              <span className="mr-1 text-[9px] text-[var(--color-accent)]">AI</span>{narrative.narrative}
              {narrative.parameterFlow && <div className="mt-1 text-[var(--color-ink-faint)]">参数：{narrative.parameterFlow}</div>}
            </div>
          )}
        </button>
        <div className="mt-1 text-center text-[9px] text-[var(--color-ink-faint)]">{LANE[step.kind]}</div>
      </div>
    </div>
  );
}

function EvidenceBadge({ confidence }: { confidence: "exact" | "likely" }) {
  return <span className={`ml-auto shrink-0 rounded px-1.5 py-0.5 text-[8.5px] ${confidence === "exact" ? "bg-[var(--color-success)]/10 text-[var(--color-success)]" : "bg-[var(--color-warn)]/10 text-[var(--color-warn)]"}`}>
    {confidence === "exact" ? "确定" : "推断"}
  </span>;
}

function Narrative({ value }: { value: TraceNarrativeDto }) {
  return (
    <section className="mb-6 rounded-lg border border-[var(--color-accent)]/25 bg-[var(--color-accent)]/5 px-4 py-3">
      <div className="mb-1 text-[9px] uppercase tracking-wider text-[var(--color-accent)]">AI 生成的链路叙述</div>
      <p className="text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">{value.summary}</p>
    </section>
  );
}

function TypeFlows({ trace }: { trace: TraceDto }) {
  if (trace.typeFlows.length === 0) return null;
  return (
    <section className="mt-2 rounded-lg border border-[var(--color-line)] bg-[var(--color-surface)] p-4">
      <h2 className="text-[12px] font-medium">数据结构流转 <span className="ml-1 text-[9px] font-normal text-[var(--color-warn)]">签名推断</span></h2>
      <div className="mt-3 space-y-2">
        {trace.typeFlows.slice(0, 20).map((flow) => (
          <div key={flow.type} className="flex items-start gap-3 text-[10.5px]">
            <code className="max-w-[280px] shrink-0 rounded bg-[var(--color-canvas)] px-2 py-1 text-[var(--color-accent)]">{flow.type}</code>
            <div className="flex flex-wrap items-center gap-1 pt-1 text-[var(--color-ink-muted)]">
              {flow.through.map((point, index) => (
                <span key={`${point.ordinal}:${point.role}`}>
                  {index > 0 && <span className="mx-1 text-[var(--color-ink-faint)]">→</span>}
                  {point.label} <span className="text-[var(--color-ink-faint)]">({point.role === "parameter" ? "参数" : "返回"})</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function TraceState({ text }: { text: string }) {
  return <div className="flex h-full items-center justify-center text-[12px] text-[var(--color-ink-faint)]">{text}</div>;
}
