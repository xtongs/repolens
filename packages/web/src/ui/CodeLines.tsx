import type { CSSProperties, ReactNode, Ref } from "react";
import type { CodeToken } from "../lib/highlight";

const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

/** 行内的一段标记，列是 UTF-16 偏移，左闭右开 */
export interface CodeMark {
  from: number;
  to: number;
  className: string;
  title?: string;
  onClick?: () => void;
}

/** 按标记边界切开高亮 token；同一标记下的碎片收进一个外层 span，背景和下划线才是连续的 */
function markedRuns(text: string, tokens: CodeToken[] | null | undefined, marks: readonly CodeMark[]) {
  const base: CodeToken[] = tokens && tokens.length > 0 ? tokens : [[text, null, 0]];
  const runs: Array<{ mark: CodeMark | null; pieces: CodeToken[] }> = [];
  let offset = 0;
  for (const token of base) {
    const value = token[0];
    let start = 0;
    while (start < value.length) {
      const at = offset + start;
      const mark = marks.find((item) => at >= item.from && at < item.to) ?? null;
      let end = value.length;
      for (const item of marks) {
        if (item.from > at) end = Math.min(end, item.from - offset);
        if (item.to > at) end = Math.min(end, item.to - offset);
      }
      const piece: CodeToken = [value.slice(start, end), token[1], token[2]];
      const last = runs.at(-1);
      if (last && last.mark === mark) last.pieces.push(piece);
      else runs.push({ mark, pieces: [piece] });
      start = end;
    }
    offset += value.length;
  }
  return runs;
}

function tokenStyle([, color, fontStyle]: CodeToken): CSSProperties | undefined {
  if (color === null && fontStyle === 0) return undefined;
  return {
    ...(color === null ? {} : { color }),
    ...(fontStyle & ITALIC ? { fontStyle: "italic" } : {}),
    ...(fontStyle & BOLD ? { fontWeight: 600 } : {}),
    ...(fontStyle & UNDERLINE ? { textDecoration: "underline" } : {}),
  };
}

export function CodeLine({
  number,
  text,
  tokens,
  marked = false,
  noted = false,
  gutter,
  lineRef,
  marks,
  wrap = false,
}: {
  number: number | null;
  text: string;
  tokens: CodeToken[] | null | undefined;
  marked?: boolean;
  /** 这一行记过笔记，行号换成笔记色 */
  noted?: boolean;
  /** 行号左侧的细色条，用来把一段源码归到某个伪代码步骤；undefined 时不占位 */
  gutter?: string | null;
  lineRef?: Ref<HTMLDivElement>;
  marks?: readonly CodeMark[];
  /** 超宽时在容器内折行，续行悬挂缩进，和真正的换行区分开 */
  wrap?: boolean;
}) {
  let content: ReactNode;
  if (marks && marks.length > 0) {
    content = markedRuns(text, tokens, marks).map((run, index) => {
      const pieces = run.pieces.map((token, i) => <span key={i} style={tokenStyle(token)}>{token[0]}</span>);
      if (!run.mark) return <span key={index}>{pieces}</span>;
      const { className, title, onClick } = run.mark;
      return (
        <span key={index} className={className} title={title} onClick={onClick}>
          {pieces}
        </span>
      );
    });
  } else if (tokens && tokens.length > 0) {
    content = tokens.map((token, index) => (
      <span key={index} style={tokenStyle(token)}>
        {token[0]}
      </span>
    ));
  } else {
    content = text || " ";
  }
  return (
    <div
      ref={lineRef}
      data-line={number ?? undefined}
      className={`mono flex text-[11px] leading-[1.6] transition-colors ${
        marked ? "bg-[var(--color-accent)]/12" : ""
      }`}
    >
      {gutter !== undefined && (
        <span className="w-[3px] shrink-0" style={{ background: gutter ?? "transparent" }} />
      )}
      {number !== null && (
        <span
          className={`w-10 shrink-0 select-none pr-2.5 text-right tabular-nums ${
            noted ? "text-[var(--color-note)]" : "text-[var(--color-ink-faint)]"
          }`}
        >
          {number}
        </span>
      )}
      {wrap ? (
        <span
          className="min-w-0 whitespace-pre-wrap text-[var(--code-foreground)] [overflow-wrap:anywhere]"
          style={{ paddingLeft: "2ch", textIndent: "-2ch" }}
        >
          {content}
        </span>
      ) : (
        <span className="whitespace-pre pr-3 text-[var(--code-foreground)]">{content}</span>
      )}
    </div>
  );
}

/** 一段连续源码。宽度撑到最长的一行，横向滚动交给外层容器。 */
export function CodeBlock({
  lines,
  tokens,
  firstLine,
  className = "",
}: {
  lines: string[];
  tokens: CodeToken[][] | null;
  firstLine: number;
  className?: string;
}) {
  return (
    <div className={`thin-scroll overflow-x-auto ${className}`}>
      <div className="w-max min-w-full py-1.5">
        {lines.map((line, index) => {
          const number = firstLine + index;
          return (
            <CodeLine key={number} number={number} text={line} tokens={tokens?.[index]} />
          );
        })}
      </div>
    </div>
  );
}
