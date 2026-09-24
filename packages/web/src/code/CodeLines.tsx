import type { CSSProperties, Ref } from "react";
import type { CodeToken } from "../lib/highlight";

const ITALIC = 1;
const BOLD = 2;
const UNDERLINE = 4;

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
  gutter,
  lineRef,
}: {
  number: number | null;
  text: string;
  tokens: CodeToken[] | null | undefined;
  marked?: boolean;
  /** 行号左侧的细色条，用来把一段源码归到某个伪代码步骤；undefined 时不占位 */
  gutter?: string | null;
  lineRef?: Ref<HTMLDivElement>;
}) {
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
        <span className="w-10 shrink-0 select-none pr-2.5 text-right tabular-nums text-[var(--color-ink-faint)]">
          {number}
        </span>
      )}
      <span className="whitespace-pre pr-3 text-[var(--code-foreground)]">
        {tokens && tokens.length > 0
          ? tokens.map((token, index) => (
              <span key={index} style={tokenStyle(token)}>
                {token[0]}
              </span>
            ))
          : text || " "}
      </span>
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
