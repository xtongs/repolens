import type { NoteDto, PseudocodeStepDto } from "@repolens/core/types";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useT } from "../i18n";
import { readPref, writePref } from "../lib/prefs";
import { NoteCard } from "../notes/NoteCard";
import { formatLines } from "../store/useNotesStore";
import { Chevron } from "./Chevron";
import { CodeLine } from "./CodeLines";
import { hasLines } from "./PseudocodePanel";
import { useSource } from "./useSource";

const ANNOTATION_STORAGE_KEY = "repolens:source-annotations";
const STEP_COLOR = "color-mix(in srgb, var(--color-accent) 55%, transparent)";
const TOP_STEP_BACKGROUND = "color-mix(in srgb, var(--color-accent) 10%, transparent)";
const CHILD_STEP_BACKGROUND = "color-mix(in srgb, var(--color-accent) 5%, transparent)";
const NOTE_BACKGROUND = "color-mix(in srgb, var(--color-note) 9%, transparent)";

export interface SourceFocus {
  lines: [number, number];
  /** 同一范围连续跳转两次也要重新滚动 */
  nonce: number;
}

interface Anchor {
  step: PseudocodeStepDto;
  label: string;
  /** 顶层步骤的序号；子步骤为 null */
  index: number | null;
}

/**
 * 源码标签页。
 *
 * 有伪代码时默认把步骤作为注解插在它描述的那几行代码上方，左侧色条标出
 * 每一步覆盖的范围——这是「读源码时手边有一份提纲」，与伪代码标签页的
 * 「先看提纲、按需下钻源码」互为两个方向。每一步都能折叠，折起全部时
 * 就退化成带行号的伪代码。
 */
export function SourcePanel({
  fileId,
  from,
  to,
  steps,
  focus,
  notes,
}: {
  fileId: string;
  from?: number;
  to?: number;
  steps?: PseudocodeStepDto[] | null;
  focus?: SourceFocus | null;
  /** 这个文件上的笔记；带行号的插在所记范围的最后一行下面 */
  notes?: NoteDto[];
}) {
  const t = useT();
  const { source, error } = useSource(fileId, from, to);
  const annotatable = hasLines(steps);
  const [annotate, setAnnotate] = useState(readAnnotationPreference);
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set());
  const [marked, setMarked] = useState<[number, number] | null>(null);
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null);
  const lineRefs = useRef(new Map<number, HTMLDivElement>());
  const viewportWidth = useElementWidth(scroller);

  const showAnnotations = annotatable && annotate;
  const topSteps = useMemo(() => steps ?? [], [steps]);

  const anchors = useMemo(() => {
    const map = new Map<number, Anchor[]>();
    if (!showAnnotations) return map;
    const add = (line: number, anchor: Anchor) => map.set(line, [...(map.get(line) ?? []), anchor]);
    topSteps.forEach((step, index) => {
      if (step.lines) add(step.lines[0], { step, label: String(index + 1), index });
      for (const child of step.children) {
        // 和父步骤同一行开始的子步骤并进父注解里，不再单独占一行
        if (child.lines && child.lines[0] !== step.lines?.[0]) add(child.lines[0], { step: child, label: "•", index: null });
      }
    });
    return map;
  }, [showAnnotations, topSteps]);

  /** 每行归属的顶层步骤；重叠时后出现的步骤覆盖先出现的，与注解的阅读顺序一致 */
  const owners = useMemo(() => {
    if (!source || !showAnnotations) return null;
    const owner = new Int32Array(source.lines.length).fill(-1);
    topSteps.forEach((step, index) => {
      if (!step.lines) return;
      for (let line = step.lines[0]; line <= step.lines[1]; line++) {
        const offset = line - source.slice.startLine;
        if (offset >= 0 && offset < owner.length) owner[offset] = index;
      }
    });
    return owner;
  }, [source, showAnnotations, topSteps]);

  /** 按笔记范围的最后一行归组；范围超出当前片段的落到片段边上 */
  const noteRows = useMemo(() => {
    const map = new Map<number, NoteDto[]>();
    if (!source) return { at: map, covered: () => false };
    const { startLine, endLine } = source.slice;
    const ranged = (notes ?? []).flatMap((note) =>
      note.target.kind === "file" && note.target.lines ? [{ note, lines: note.target.lines }] : [],
    );
    for (const { note, lines } of ranged) {
      if (lines[1] < startLine || lines[0] > endLine) continue;
      const line = Math.min(lines[1], endLine);
      map.set(line, [...(map.get(line) ?? []), note]);
    }
    const covered = (line: number) => ranged.some(({ lines }) => line >= lines[0] && line <= lines[1]);
    return { at: map, covered };
  }, [source, notes]);

  const loaded = source !== null;
  useEffect(() => {
    if (!focus || !loaded) return;
    setMarked(focus.lines);
    setFolded((current) => {
      const next = new Set(current);
      topSteps.forEach((step, index) => {
        if (step.lines && step.lines[0] <= focus.lines[1] && step.lines[1] >= focus.lines[0]) next.delete(index);
      });
      return next.size === current.size ? current : next;
    });
    const frame = requestAnimationFrame(() => {
      lineRefs.current.get(focus.lines[0])?.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus, loaded, topSteps]);

  if (error) return <div className="p-3 text-[11.5px] text-[var(--color-ink-faint)]">{error}</div>;
  if (!source) return <SourceSkeleton />;

  const toggleFold = (index: number) =>
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });

  const rows: ReactNode[] = [];
  const pushNotes = (line: number) => {
    for (const note of noteRows.at.get(line) ?? []) {
      rows.push(<SourceNote key={`n:${note.id}`} note={note} width={viewportWidth} gutter={showAnnotations} />);
    }
  };
  const foldedStepAt = (line: number) =>
    topSteps.findIndex((step, index) => folded.has(index) && step.lines && line >= step.lines[0] && line <= step.lines[1]);

  for (let offset = 0; offset < source.lines.length; offset++) {
    const line = source.slice.startLine + offset;
    const foldedIndex = showAnnotations ? foldedStepAt(line) : -1;

    for (const anchor of anchors.get(line) ?? []) {
      // 折叠范围内只保留折叠步骤自己的注解
      if (foldedIndex >= 0 && anchor.index !== foldedIndex) continue;
      rows.push(
        <Annotation
          key={`a:${line}:${anchor.label}:${anchor.step.text}`}
          anchor={anchor}
          width={viewportWidth}
          folded={anchor.index !== null && folded.has(anchor.index)}
          onToggle={anchor.index !== null ? () => toggleFold(anchor.index!) : undefined}
        />,
      );
    }

    if (foldedIndex >= 0) {
      const range = topSteps[foldedIndex]!.lines!;
      if (line === Math.max(range[0], source.slice.startLine)) {
        rows.push(
          <button
            key={`f:${line}`}
            type="button"
            onClick={() => toggleFold(foldedIndex)}
            className="sticky left-0 block py-0.5 pl-[calc(2.5rem+3px)] text-left text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-accent)]"
            style={{ width: viewportWidth || undefined }}
          >
            ⋯ {t("已折叠 L{from}–{to}，共 {count} 行", { from: range[0], to: range[1], count: range[1] - range[0] + 1 })}
          </button>,
        );
      }
      // 折起来的代码里记过的笔记照样露出来，笔记比那几行代码更值得一眼看到
      pushNotes(line);
      continue;
    }

    const owner = owners?.[offset] ?? -1;
    rows.push(
      <CodeLine
        key={line}
        number={line}
        text={source.lines[offset] ?? ""}
        tokens={source.tokens?.[offset]}
        marked={marked !== null && line >= marked[0] && line <= marked[1]}
        noted={noteRows.covered(line)}
        gutter={showAnnotations ? (owner >= 0 ? STEP_COLOR : null) : undefined}
        lineRef={(el) => {
          if (el) lineRefs.current.set(line, el);
          else lineRefs.current.delete(line);
        }}
      />,
    );
    pushNotes(line);
  }

  const allFolded = topSteps.every((step, index) => !step.lines || folded.has(index));

  return (
    <div className="flex min-h-full flex-col" data-source-file={fileId}>
      <div className="sticky top-0 z-10 flex h-8 shrink-0 items-center gap-2 border-b border-[var(--color-line)] bg-[var(--color-surface)]/95 px-3 text-[10.5px] text-[var(--color-ink-faint)] backdrop-blur">
        <span className="mono truncate tabular-nums">
          L{source.slice.startLine}–{source.slice.endLine} · {t("{count} 行", { count: source.lines.length })}
        </span>
        {annotatable && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {showAnnotations && (
              <button
                type="button"
                onClick={() =>
                  setFolded(allFolded ? new Set() : new Set(topSteps.flatMap((step, i) => (step.lines ? [i] : []))))
                }
                className="rounded px-1.5 py-0.5 transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink-muted)]"
              >
                {allFolded ? t("全部展开") : t("全部折叠")}
              </button>
            )}
            <button
              type="button"
              aria-pressed={annotate}
              onClick={() => {
                const next = !annotate;
                setAnnotate(next);
                writeAnnotationPreference(next);
              }}
              title={t("在源码中穿插 AI 伪代码步骤")}
              className={`rounded border px-1.5 py-0.5 transition-colors ${
                annotate
                  ? "border-[var(--color-accent)]/50 text-[var(--color-accent)]"
                  : "border-[var(--color-line)] hover:text-[var(--color-ink-muted)]"
              }`}
            >
              {t("伪代码注解")}
            </button>
          </div>
        )}
      </div>
      <div ref={setScroller} className="thin-scroll flex-1 overflow-x-auto">
        <div className="w-max min-w-full py-2">{rows}</div>
      </div>
    </div>
  );
}

/**
 * 和 CodeLine 用同一套列：色条、行号列、正文。序号和圆点落在行号列里与行号
 * 右对齐，文字从代码首列开始，读的时候注解和它下面的代码是一条竖线。
 */
function Annotation({
  anchor,
  width,
  folded,
  onToggle,
}: {
  anchor: Anchor;
  width: number;
  folded: boolean;
  onToggle: (() => void) | undefined;
}) {
  const t = useT();
  const top = anchor.index !== null;
  const lines = anchor.step.lines;
  const merged = top ? anchor.step.children.filter((child) => child.lines?.[0] === lines?.[0]) : [];
  return (
    <div
      className={`sticky left-0 flex items-baseline pr-2 ${top ? "mt-2 first:mt-0 py-1" : "py-0.5"}`}
      style={{ width: width || undefined, background: top ? TOP_STEP_BACKGROUND : CHILD_STEP_BACKGROUND }}
    >
      <span className="w-[3px] shrink-0 self-stretch" style={{ background: top ? "var(--color-accent)" : STEP_COLOR }} />
      <span
        className={`mono w-10 shrink-0 select-none pr-2.5 text-right text-[11px] leading-[1.6] tabular-nums ${
          top ? "font-semibold text-[var(--color-accent)]" : "text-[var(--color-accent)]/70"
        }`}
      >
        {anchor.label}
      </span>
      <span
        className={`min-w-0 flex-1 pr-1 leading-[1.6] ${
          top ? "text-[11.5px] font-medium text-[var(--color-ink)]" : "text-[11px] text-[var(--color-ink-muted)]"
        }`}
      >
        {anchor.step.text}
        {merged.length > 0 && (
          <span className="ml-1 text-[11px] font-normal text-[var(--color-ink-muted)]">
            · {merged.map((child) => child.text).join(" · ")}
          </span>
        )}
      </span>
      {onToggle && (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={!folded}
          title={folded ? t("展开这一步的源码") : t("折叠这一步的源码")}
          className="flex h-[1.6em] w-4 shrink-0 self-start items-center justify-center rounded text-[11.5px] text-[var(--color-ink-faint)] transition-colors hover:bg-[var(--color-surface-3)] hover:text-[var(--color-ink)]"
        >
          <Chevron open={!folded} />
        </button>
      )}
    </div>
  );
}

/**
 * 源码里的笔记，和注解同一套列：行号列放 ✎，正文从代码首列开始。
 * 默认只露两行，点开是完整的笔记卡片，可以在这里直接删。
 */
function SourceNote({ note, width, gutter }: { note: NoteDto; width: number; gutter: boolean }) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const lines = note.target.kind === "file" ? note.target.lines : null;
  return (
    <div
      className="sticky left-0 my-1 flex items-baseline pr-2"
      // 没有步骤色条那一列时用内阴影画竖条，不占宽度，行号列才能和代码对齐
      style={{
        width: width || undefined,
        background: NOTE_BACKGROUND,
        boxShadow: gutter ? undefined : "inset 3px 0 0 var(--color-note)",
      }}
    >
      {gutter && <span className="w-[3px] shrink-0 self-stretch bg-[var(--color-note)]" />}
      <span className="mono w-10 shrink-0 select-none pr-2.5 text-right text-[11px] leading-[1.6] text-[var(--color-note)]">
        ✎
      </span>
      {open ? (
        <div className="min-w-0 flex-1 py-1.5 pr-1">
          <NoteCard note={note} showPath={false} onLocate={null} />
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="mt-1 text-[10.5px] text-[var(--color-ink-faint)] transition-colors hover:text-[var(--color-ink-muted)]"
          >
            {t("收起笔记")}
          </button>
        </div>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setOpen(true)}
            title={t("展开笔记")}
            className="min-w-0 flex-1 py-1 text-left text-[11px] leading-[1.6] text-[var(--color-ink-muted)] transition-colors hover:text-[var(--color-ink)]"
          >
            <span className="line-clamp-2">{notePreview(note.text)}</span>
          </button>
          {lines && (
            <span className="mono shrink-0 pl-2 text-[10px] leading-[1.6] text-[var(--color-ink-faint)]">
              {formatLines(lines)}
            </span>
          )}
        </>
      )}
    </div>
  );
}

/** 只去掉 Markdown 标记本身，单个下划线和星号多半是标识符或表达式的一部分 */
function notePreview(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " … ")
    .replace(/`+/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/^\s*(?:#+|>|[-*]\s)\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function SourceSkeleton() {
  return (
    <div className="space-y-2 p-3">
      {[...Array(6)].map((_, i) => (
        <div
          key={i}
          className="h-3 animate-pulse rounded bg-[var(--color-surface-3)]"
          style={{ width: `${88 - i * 11}%` }}
        />
      ))}
    </div>
  );
}

/** 注解要在横向滚动时保持可见并按可视宽度换行，所以宽度取滚动容器的可视宽度。 */
function useElementWidth(element: HTMLElement | null): number {
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!element) return;
    setWidth(element.clientWidth);
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return width;
}

function readAnnotationPreference(): boolean {
  return readPref(ANNOTATION_STORAGE_KEY) !== "off";
}

function writeAnnotationPreference(value: boolean): void {
  writePref(ANNOTATION_STORAGE_KEY, value ? "on" : "off");
}
