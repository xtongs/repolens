import type { Confidence, IoKind, IoReachDto, WalkCallDto, WalkFrameDto, WalkTargetDto } from "@repolens/core/types";
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { api } from "../api/client";
import { useSource } from "../code/useSource";
import { msg, useT } from "../i18n";
import { useSidebarInset } from "../layout/ResizablePanelHandle";
import { useAppStore, type WalkFrameRef } from "../store/useAppStore";
import { CodeLine, type CodeMark } from "../ui/CodeLines";

export const IO_LABELS: Record<IoKind, string> = {
  database: msg("数据库"),
  network: msg("网络"),
  filesystem: msg("文件系统"),
  "message-queue": msg("消息队列"),
  process: msg("子进程"),
};

const RESOLUTION_LABELS: Record<Confidence, string> = {
  exact: msg("确定"),
  likely: msg("可能"),
  ambiguous: msg("多义"),
  external: msg("外部"),
  unresolved: msg("未解析"),
};

/** 默认只把能落到仓库内函数的调用和 I/O 当步骤，和服务端算「还能走几步」的口径一致 */
function walkable(call: WalkCallDto): boolean {
  return call.resolution === "exact" || call.resolution === "likely" || call.resolution === "ambiguous" || !!call.io;
}

function visibleSteps(frame: WalkFrameDto, all: boolean): WalkCallDto[] {
  return all ? frame.calls : frame.calls.filter(walkable);
}

function steppable(call: WalkCallDto | null): WalkTargetDto | null {
  return call && call.resolution !== "ambiguous" ? call.target ?? null : null;
}

/** 落不到仓库里的调用要说清楚落在哪、为什么推不出来，一律「确定不了」等于什么都没说 */
function callNote(call: WalkCallDto, t: ReturnType<typeof useT>): string | null {
  if (call.resolution === "external") {
    const name = call.external ?? call.callee;
    return call.builtin ? t("语言内置 {name}", { name }) : t("外部库 {name}", { name });
  }
  if (call.resolution !== "unresolved") return null;
  const reason = call.unresolved;
  switch (reason?.kind) {
    case "callback":
      return t("{name} 是参数传进来的函数，要看调用方传了什么", { name: call.callee });
    case "function-value":
      if (!reason.source) {
        return t("{name} 不是本文件定义或 import 的函数，可能来自闭包、变量或运行时注入", { name: call.callee });
      }
      return reason.destructured
        ? t("{name} 是从 {source} 的返回值里解构出来的函数，静态分析不追踪函数值", { name: call.callee, source: reason.source })
        : t("{name} 是 {source} 返回的函数，静态分析不追踪函数值", { name: call.callee, source: reason.source });
    case "chained":
      return t("接在上一个调用的返回值上，推不出这个返回值的类型");
    case "untyped": {
      const receiver = shorten(call.receiver ?? "");
      if (reason.source) return t("{receiver} 来自 {source} 的返回值，推不出它的类型", { receiver, source: reason.source });
      if (reason.param) return t("{receiver} 是没标类型的参数，推不出它的类型", { receiver });
      return t("推不出 {receiver} 的类型，多半是内置对象或外部库返回的数据", { receiver });
    }
    case "inherited":
      return t("类和父类里都没找到这个方法，可能是运行时挂上去的");
    default:
      return t("静态分析确定不了它调的是哪个函数");
  }
}

// ---------------------------------------------------------------------------
// 帧缓存：步出再步入同一个函数、来回切换显示范围都不该重新请求
// ---------------------------------------------------------------------------

const frameCache = new Map<string, Promise<WalkFrameDto>>();
const FRAME_CACHE_SIZE = 64;

function frameKey(id: string): string {
  const { repoId, repoRevision } = useAppStore.getState();
  return `${repoId ?? ""}:${repoRevision}:${id}`;
}

function loadFrame(id: string): Promise<WalkFrameDto> {
  const key = frameKey(id);
  const cached = frameCache.get(key);
  if (cached) return cached;
  const task = api.walk(id);
  frameCache.set(key, task);
  task.catch(() => frameCache.delete(key));
  if (frameCache.size > FRAME_CACHE_SIZE) {
    const oldest = frameCache.keys().next().value;
    if (oldest !== undefined) frameCache.delete(oldest);
  }
  return task;
}

function useWalkFrames(ids: readonly string[]): { frames: Map<string, WalkFrameDto>; error: string | null } {
  const [frames, setFrames] = useState(() => new Map<string, WalkFrameDto>());
  const [error, setError] = useState<string | null>(null);
  const joined = ids.join(",");

  useEffect(() => {
    let cancelled = false;
    setError(null);
    for (const id of joined.split(",")) {
      void loadFrame(id)
        .then((frame) => {
          if (cancelled) return;
          setFrames((current) => (current.get(id) === frame ? current : new Map(current).set(id, frame)));
        })
        .catch((err: Error) => !cancelled && setError(err.message));
    }
    return () => {
      cancelled = true;
    };
  }, [joined]);

  return { frames, error };
}

// ---------------------------------------------------------------------------
// 走读视图
// ---------------------------------------------------------------------------

/**
 * 单步走读：一次看一个函数，按执行顺序停在它体内的每一处调用上，
 * 可以步入被调函数（跨文件也一样）、步出回到调用方。调用栈就是走过的路径。
 */
export function WalkView() {
  const t = useT();
  const walk = useAppStore((s) => s.walk);
  const allCalls = useAppStore((s) => s.walkAllCalls);
  const setAllCalls = useAppStore((s) => s.setWalkAllCalls);
  const setStack = useAppStore((s) => s.setWalkStack);
  const closeWalk = useAppStore((s) => s.closeWalk);
  const select = useAppStore((s) => s.select);
  const stack = walk?.stack ?? EMPTY_STACK;
  const top = stack.at(-1) ?? null;
  const { frames, error } = useWalkFrames(stack.map((ref) => ref.id));
  const frame = top ? frames.get(top.id) ?? null : null;

  const steps = useMemo(() => (frame ? visibleSteps(frame, allCalls) : []), [frame, allCalls]);
  const index = top ? steps.findIndex((call) => call.id === top.at) : -1;
  const current = index >= 0 ? steps[index] ?? null : null;
  const caller = stack.length > 1 ? stack[stack.length - 2] ?? null : null;

  // 刚步入时停在第一步；停的那处被筛掉后挪到它后面最近的一步
  useEffect(() => {
    if (!frame || !top || frame.id !== top.id || index >= 0) return;
    let at: string | null = steps[0]?.id ?? null;
    if (top.at !== null) {
      const position = frame.calls.findIndex((call) => call.id === top.at);
      const visible = new Set(steps.map((call) => call.id));
      at = frame.calls.slice(position + 1).find((call) => visible.has(call.id))?.id ?? steps.at(-1)?.id ?? null;
    }
    if (at !== top.at || frame.name !== top.name) {
      setStack([...stack.slice(0, -1), { ...top, name: frame.name, at }]);
    }
  }, [frame, top, index, steps, stack, setStack]);

  // 步入前先把下一帧取回来，按下 → 时不用等
  const nextTarget = steppable(current);
  useEffect(() => {
    if (nextTarget) void loadFrame(nextTarget.id).catch(() => {});
  }, [nextTarget]);

  const actions = {
    goto(at: string) {
      if (top) setStack([...stack.slice(0, -1), { ...top, at }]);
    },
    next() {
      const following = steps[index + 1];
      if (following) return actions.goto(following.id);
      // 函数走完了：和调试器一样回到调用方，并前进到它的下一步
      if (!caller) return;
      const callerFrame = frames.get(caller.id);
      const callerSteps = callerFrame ? visibleSteps(callerFrame, allCalls) : [];
      const at = callerSteps[callerSteps.findIndex((call) => call.id === caller.at) + 1]?.id ?? caller.at;
      setStack([...stack.slice(0, -2), { ...caller, at }]);
    },
    prev() {
      const previous = steps[index - 1];
      if (previous) actions.goto(previous.id);
    },
    into(target: WalkTargetDto | null = nextTarget) {
      if (target) setStack([...stack, { id: target.id, name: target.name, at: null }]);
    },
    out(depth = stack.length - 2) {
      if (depth >= 0 && depth < stack.length - 1) setStack(stack.slice(0, depth + 1));
    },
  };
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const rootRef = useRef<HTMLDivElement>(null);
  const inset = { paddingLeft: useSidebarInset("left"), paddingRight: useSidebarInset("right") };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      // 焦点在输入框，或在详情抽屉、左侧面板这些叠在上面的侧栏里时，按键留给它们
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const panel = target?.closest("aside");
      if (panel && !rootRef.current?.contains(panel)) return;
      const run = actionsRef.current;
      const key = event.key;
      if (key === "ArrowDown" || key === "j" || key === "F10") run.next();
      else if (key === "ArrowUp" || key === "k") run.prev();
      else if ((key === "F11" && event.shiftKey) || key === "ArrowLeft" || key === "h") run.out();
      else if (key === "ArrowRight" || key === "l" || key === "F11") run.into();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!walk || !top) return null;
  if (error && !frame) {
    return (
      <div ref={rootRef} className="flex h-full flex-col bg-[var(--color-canvas)]" style={inset}>
        <WalkMessage>
          <div>{error}</div>
          <button type="button" onClick={stack.length > 1 ? () => actions.out() : closeWalk}
            className="mt-3 rounded-md border border-[var(--color-line)] px-2.5 py-1 text-[11px] hover:border-[var(--color-line-strong)]">
            {stack.length > 1 ? t("步出") : t("返回结构图")}
          </button>
        </WalkMessage>
      </div>
    );
  }

  return (
    <div ref={rootRef} className="flex h-full flex-col bg-[var(--color-canvas)]" style={inset}>
      <CallStack stack={stack} frames={frames} onOut={(depth) => actions.out(depth)} />

      {frame === null ? (
        <WalkMessage>{t("正在读取函数…")}</WalkMessage>
      ) : (
        <>
          <header className="flex shrink-0 items-start gap-4 border-b border-[var(--color-line)] px-5 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <h1 className="mono truncate text-[14px] font-medium text-[var(--color-ink)]">{frame.name}</h1>
                <span className="mono truncate text-[10.5px] text-[var(--color-ink-faint)]">
                  {frame.filePath}:{frame.startLine}–{frame.endLine}
                </span>
              </div>
              {frame.summary && (
                <p className="mt-1 text-[11.5px] leading-relaxed text-[var(--color-ink-muted)]">{frame.summary}</p>
              )}
              <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                <Reaches reaches={frame.reaches} />
                <button type="button" onClick={() => select(frame.id)}
                  className="text-[10.5px] text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink)] hover:underline">
                  {t("查看详情")}
                </button>
              </div>
            </div>
            <StepButtons
              canPrev={index > 0}
              canNext={index < steps.length - 1 || caller !== null}
              canInto={nextTarget !== null}
              canOut={caller !== null}
              actions={actions}
            />
          </header>

          <div className="flex min-h-0 flex-1">
            <StepList
              frame={frame}
              steps={steps}
              current={current}
              allCalls={allCalls}
              caller={caller ? frames.get(caller.id)?.name ?? caller.name : null}
              onPick={actions.goto}
              onShowAll={() => setAllCalls(true)}
            />
            <FrameSource
              key={frame.id}
              frame={frame}
              steps={steps}
              current={current}
              stackIds={stack.map((ref) => ref.id)}
              onPick={actions.goto}
              onInto={actions.into}
            />
          </div>
        </>
      )}
    </div>
  );
}

const EMPTY_STACK: WalkFrameRef[] = [];

function WalkMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center p-8 text-center text-[12px] text-[var(--color-ink-faint)]">
      {children}
    </div>
  );
}

/** 自入口起的调用栈，点哪一帧就步出到哪一帧 */
function CallStack({ stack, frames, onOut }: {
  stack: readonly WalkFrameRef[];
  frames: ReadonlyMap<string, WalkFrameDto>;
  onOut: (depth: number) => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    ref.current?.scrollTo({ left: ref.current.scrollWidth });
  }, [stack.length]);

  return (
    <div ref={ref} className="thin-scroll flex h-9 shrink-0 items-center gap-1 overflow-x-auto border-b border-[var(--color-line)] bg-[var(--color-surface)] px-3">
      <span className="mr-1 shrink-0 text-[10px] uppercase tracking-wider text-[var(--color-ink-faint)]">{t("调用栈")}</span>
      {stack.map((ref, depth) => {
        const frame = frames.get(ref.id);
        const last = depth === stack.length - 1;
        const file = frame?.filePath.split("/").at(-1);
        const crossFile = depth > 0 && frame && frames.get(stack[depth - 1]!.id)?.fileId !== frame.fileId;
        return (
          <Fragment key={`${depth}:${ref.id}`}>
            {depth > 0 && <span className="shrink-0 text-[10px] text-[var(--color-ink-faint)]">›</span>}
            <button
              type="button"
              disabled={last}
              onClick={() => onOut(depth)}
              title={frame ? `${frame.filePath}:${frame.startLine}` : undefined}
              className={`flex max-w-72 shrink-0 items-baseline gap-1.5 rounded px-1.5 py-0.5 text-left transition-colors ${
                last
                  ? "bg-[var(--color-accent)]/12 text-[var(--color-ink)]"
                  : "text-[var(--color-ink-muted)] hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
              }`}
            >
              <span className="mono truncate text-[11px]">{frame?.name ?? ref.name}</span>
              {file && (
                <span className={`mono shrink-0 text-[9.5px] ${crossFile ? "text-[var(--color-accent)]" : "text-[var(--color-ink-faint)]"}`}>
                  {file}
                </span>
              )}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}

function StepButtons({ canPrev, canNext, canInto, canOut, actions }: {
  canPrev: boolean; canNext: boolean; canInto: boolean; canOut: boolean;
  actions: { prev: () => void; next: () => void; into: () => void; out: () => void };
}) {
  const t = useT();
  const button = (label: string, key: string, enabled: boolean, run: () => void, title: string) => (
    <button type="button" disabled={!enabled} onClick={run} title={title}
      className="flex items-center gap-1.5 rounded-md border border-[var(--color-line)] px-2 py-1 text-[11px] text-[var(--color-ink-muted)] transition-colors enabled:hover:border-[var(--color-line-strong)] enabled:hover:text-[var(--color-ink)] disabled:opacity-40">
      {label}
      <kbd className="mono rounded bg-[var(--color-surface-3)] px-1 text-[10px] text-[var(--color-ink-faint)]">{key}</kbd>
    </button>
  );
  return (
    <div className="flex shrink-0 items-center gap-1.5">
      {button(t("上一步"), "↑", canPrev, actions.prev, t("回到上一处调用"))}
      {button(t("下一步"), "↓", canNext, actions.next, t("跳过这次调用，停到下一处；函数走完时回到调用方"))}
      {button(t("步入"), "→", canInto, () => actions.into(), t("进入被调函数，跨文件也一样"))}
      {button(t("步出"), "←", canOut, () => actions.out(), t("回到调用方"))}
    </div>
  );
}

function Reaches({ reaches }: { reaches: readonly IoReachDto[] }) {
  const t = useT();
  return (
    <>
      {reaches.map((reach) => (
        <span key={reach.kind}
          title={reach.depth === 0
            ? t("自己就在访问{kind}", { kind: t(IO_LABELS[reach.kind]) })
            : t("往下最少 {count} 层调用会访问{kind}", { count: reach.depth, kind: t(IO_LABELS[reach.kind]) })}
          className="rounded border border-[var(--color-warn)]/35 px-1 text-[9.5px] text-[var(--color-warn)]">
          {t(IO_LABELS[reach.kind])}{reach.depth > 0 ? ` +${reach.depth}` : ""}
        </span>
      ))}
    </>
  );
}

function StepList({ frame, steps, current, allCalls, caller, onPick, onShowAll }: {
  frame: WalkFrameDto;
  steps: readonly WalkCallDto[];
  current: WalkCallDto | null;
  allCalls: boolean;
  caller: string | null;
  onPick: (id: string) => void;
  onShowAll: () => void;
}) {
  const t = useT();
  const currentRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    currentRef.current?.scrollIntoView({ block: "nearest" });
  }, [current?.id]);
  const hidden = frame.calls.length - steps.length;
  const atEnd = current !== null && current === steps.at(-1);

  return (
    <aside className="thin-scroll flex w-72 shrink-0 flex-col overflow-y-auto border-r border-[var(--color-line)] bg-[var(--color-surface)] py-1.5">
      <div className="px-3 pb-1 text-[10px] text-[var(--color-ink-faint)]">
        {t("{count} 处调用，按执行顺序", { count: steps.length })}
      </div>
      {steps.map((call, i) => {
        const active = call === current;
        const target = call.target;
        const crossFile = target && target.fileId !== frame.fileId;
        return (
          <button
            key={call.id}
            ref={active ? currentRef : undefined}
            type="button"
            onClick={() => onPick(call.id)}
            className={`relative flex w-full items-baseline gap-2 py-1 pl-3 pr-2.5 text-left transition-colors ${
              active ? "bg-[var(--color-surface-3)]" : "hover:bg-[var(--color-surface-2)]"
            } ${walkable(call) ? "" : "opacity-55"}`}
          >
            {active && <span className="absolute inset-y-0 left-0 w-[2px] bg-[var(--color-accent)]" />}
            <span className="w-5 shrink-0 text-right text-[9.5px] tabular-nums text-[var(--color-ink-faint)]">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="mono block truncate text-[11.5px] text-[var(--color-ink)]">
                {call.receiver && <span className="text-[var(--color-ink-faint)]">{shorten(call.receiver)}.</span>}
                {call.callee}
              </span>
              <span className="mono block truncate text-[9.5px] text-[var(--color-ink-faint)]">
                L{call.line}
                {call.resolution === "ambiguous"
                  ? ` · ${t("{count} 个候选", { count: call.candidates?.length ?? 0 })}`
                  : target
                    ? ` → ${crossFile ? target.filePath.split("/").at(-1) : t("同文件")}`
                    : call.external
                      ? ` · ${call.builtin ? t("内置 {name}", { name: call.external }) : call.external}`
                      : ""}
              </span>
            </span>
            {call.io ? (
              <span className="shrink-0 rounded border border-[var(--color-warn)]/40 px-1 text-[9px] text-[var(--color-warn)]">
                {t(IO_LABELS[call.io])}
              </span>
            ) : target?.reaches[0] ? (
              <span className="shrink-0 text-[9px] text-[var(--color-warn)]/70"
                title={t("往下最少 {count} 层调用会访问{kind}", { count: target.reaches[0].depth + 1, kind: t(IO_LABELS[target.reaches[0].kind]) })}>
                ↓{t(IO_LABELS[target.reaches[0].kind])}
              </span>
            ) : null}
          </button>
        );
      })}

      {steps.length === 0 && (
        <div className="px-3 py-2 text-[11px] leading-relaxed text-[var(--color-ink-faint)]">
          {t("函数体里没有能继续走的调用。")}
        </div>
      )}
      {atEnd && caller && (
        <div className="px-3 py-2 text-[10.5px] text-[var(--color-ink-faint)]">
          {t("再按 ↓ 回到 {name}", { name: caller })}
        </div>
      )}
      {!allCalls && hidden > 0 && (
        <button type="button" onClick={onShowAll}
          className="mx-3 mt-1 text-left text-[10.5px] text-[var(--color-ink-faint)] underline-offset-2 hover:text-[var(--color-ink-muted)] hover:underline">
          {t("另有 {count} 处外部库或无法解析的调用", { count: hidden })}
        </button>
      )}
    </aside>
  );
}

/** 函数源码。每处步骤调用标在被调名上，当前这处下方展开说明卡片 */
function FrameSource({ frame, steps, current, stackIds, onPick, onInto }: {
  frame: WalkFrameDto;
  steps: readonly WalkCallDto[];
  current: WalkCallDto | null;
  stackIds: readonly string[];
  onPick: (id: string) => void;
  onInto: (target: WalkTargetDto) => void;
}) {
  const t = useT();
  const { source, error } = useSource(frame.fileId, frame.startLine, frame.endLine);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const focusRef = useRef<HTMLDivElement>(null);

  const byLine = useMemo(() => {
    const out = new Map<number, WalkCallDto[]>();
    for (const call of steps) {
      const bucket = out.get(call.line);
      if (bucket) bucket.push(call); else out.set(call.line, [call]);
    }
    return out;
  }, [steps]);

  // 只在当前位置跑出可视区时才滚，免得每按一步画面都跳
  useEffect(() => {
    const scroller = scrollerRef.current;
    const focus = focusRef.current;
    if (!scroller || !focus) return;
    const view = scroller.getBoundingClientRect();
    const box = focus.getBoundingClientRect();
    if (box.top < view.top + 24 || box.bottom > view.bottom - 24) focus.scrollIntoView({ block: "center" });
  }, [current?.id, source]);

  if (error) return <WalkMessage>{error}</WalkMessage>;
  if (!source) return <WalkMessage>{t("正在读取源码…")}</WalkMessage>;
  const { lines, tokens, first } = source.range(frame.startLine, frame.endLine);

  return (
    <div ref={scrollerRef} className="thin-scroll min-w-0 flex-1 overflow-auto">
      <div className="w-max min-w-full py-2">
        {lines.map((text, i) => {
          const number = first + i;
          const calls = byLine.get(number) ?? [];
          const here = current !== null && current.line === number;
          const marks = calls.flatMap((call): CodeMark[] => {
            const from = locate(text, call);
            if (from < 0) return [];
            const active = call === current;
            return [{
              from,
              to: from + call.callee.length,
              title: call.target ? `${call.target.name} · ${call.target.filePath}:${call.target.line}` : call.external ?? undefined,
              onClick: () => onPick(call.id),
              className: `cursor-pointer rounded-sm ${
                active
                  ? "bg-[var(--color-accent)]/25 outline outline-1 outline-[var(--color-accent)]"
                  : `underline decoration-dotted underline-offset-[3px] hover:bg-[var(--color-accent)]/10 ${
                      call.io ? "decoration-[var(--color-warn)]" : "decoration-[var(--color-accent)]/70"
                    }`
              }`,
            }];
          });
          const line = (
            <CodeLine
              number={number}
              text={text}
              tokens={tokens?.[i]}
              marked={here}
              gutter={here ? "var(--color-accent)" : calls.length > 0 ? "var(--color-line-strong)" : null}
              marks={marks}
            />
          );
          if (!here || !current) return <Fragment key={number}>{line}</Fragment>;
          return (
            <div key={number} ref={focusRef}>
              {line}
              <StepCard call={current} frame={frame} recursive={stackIds} onInto={onInto} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** 优先用解析时记下的列；对不上（嵌入式模板等）时退回按名字找 */
function locate(text: string, call: WalkCallDto): number {
  if (text.startsWith(call.callee, call.column)) return call.column;
  const match = new RegExp(`(?<![\\w$])${call.callee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w$])`).exec(text);
  return match ? match.index : -1;
}

function StepCard({ call, frame, recursive, onInto }: {
  call: WalkCallDto;
  frame: WalkFrameDto;
  recursive: readonly string[];
  onInto: (target: WalkTargetDto) => void;
}) {
  const t = useT();
  const target = steppable(call);
  return (
    <div className="sticky left-0 my-1.5 ml-[52px] mr-4 w-[min(640px,calc(100vw_-_380px))] rounded-md border border-[var(--color-accent)]/35 bg-[var(--color-surface)] px-3 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <span className={`rounded border px-1 text-[9.5px] ${
          call.resolution === "exact" ? "border-[var(--color-accent)]/40 text-[var(--color-accent)]"
            : call.resolution === "likely" ? "border-[var(--color-warn)]/40 text-[var(--color-warn)]"
              : "border-[var(--color-line-strong)] text-[var(--color-ink-faint)]"
        }`}>
          {t(RESOLUTION_LABELS[call.resolution])}
        </span>
        {call.io && (
          <span className="rounded border border-[var(--color-warn)]/40 px-1 text-[9.5px] text-[var(--color-warn)]">
            {t("访问{kind}", { kind: t(IO_LABELS[call.io]) })}
          </span>
        )}
        {target ? (
          <>
            <span className="mono text-[var(--color-ink)]">{target.name}</span>
            <span className={`mono text-[10px] ${target.fileId !== frame.fileId ? "text-[var(--color-accent)]" : "text-[var(--color-ink-faint)]"}`}>
              {target.filePath}:{target.line}
            </span>
          </>
        ) : call.resolution === "external" ? (
          <span className="text-[var(--color-ink-muted)]">{callNote(call, t)}</span>
        ) : call.resolution === "unresolved" ? (
          <span className="text-[var(--color-ink-faint)]">{callNote(call, t)}</span>
        ) : null}
      </div>

      {call.arguments.length > 0 && (
        <div className="mono mt-1.5 truncate text-[10.5px] text-[var(--color-ink-muted)]" title={call.arguments.join(", ")}>
          <span className="text-[var(--color-ink-faint)]">{call.callee}(</span>
          {call.arguments.join(", ")}
          <span className="text-[var(--color-ink-faint)]">)</span>
        </div>
      )}

      {target?.summary && <p className="mt-1.5 text-[11px] leading-relaxed text-[var(--color-ink-muted)]">{target.summary}</p>}

      {target && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => onInto(target)}
            className="flex items-center gap-1.5 rounded border border-[var(--color-accent)]/50 px-2 py-0.5 text-[11px] text-[var(--color-accent)] hover:bg-[var(--color-accent)]/10">
            {t("步入")}
            <kbd className="mono text-[10px]">→</kbd>
          </button>
          <span className="text-[10px] text-[var(--color-ink-faint)]">
            {target.steps > 0 ? t("里面还有 {count} 处调用", { count: target.steps }) : t("里面没有更多调用")}
          </span>
          {recursive.includes(target.id) && <span className="text-[10px] text-[var(--color-warn)]">{t("递归")}</span>}
          <Reaches reaches={target.reaches} />
        </div>
      )}

      {call.resolution === "ambiguous" && call.candidates && (
        <div className="mt-2">
          <div className="text-[10px] text-[var(--color-ink-faint)]">{t("有多个同名实现，选一个步入：")}</div>
          <div className="mt-1 space-y-0.5">
            {call.candidates.map((candidate) => (
              <button key={candidate.id} type="button" onClick={() => onInto(candidate)}
                className="flex w-full items-baseline gap-2 rounded px-1.5 py-0.5 text-left hover:bg-[var(--color-surface-3)]">
                <span className="mono text-[11px] text-[var(--color-ink)]">{candidate.name}</span>
                <span className="mono truncate text-[10px] text-[var(--color-ink-faint)]">{candidate.filePath}:{candidate.line}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/** 链式调用的接收者常是一整段带多行实参的调用，括号里的内容对认出是哪一步没有帮助 */
function shorten(receiver: string): string {
  let out = "";
  let depth = 0;
  for (const ch of receiver) {
    if ("([{".includes(ch)) {
      if (depth === 0) out += `${ch}…`;
      depth += 1;
    } else if (")]}".includes(ch)) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) out += ch;
    } else if (depth === 0) {
      out += ch;
    }
  }
  out = out.replace(/\s*\.\s*/g, ".").replace(/\s+/g, " ").trim();
  return out.length > 24 ? `…${out.slice(-22)}` : out;
}
