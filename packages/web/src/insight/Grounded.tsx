import type { GroundingDto } from "@repolens/core/types";
import { Fragment } from "react";
import { useT } from "../i18n";
import { useAppStore } from "../store/useAppStore";

const CODE_SPAN = /`([^`\n]+)`/g;

/**
 * AI 写的文字，其中反引号括起来的名字按 grounding 落到代码上：对上了就能点过去，
 * 代码里压根找不到的标出来——多半是模型编的。没有 grounding 时按原文显示。
 */
export function Grounded({ text, grounding }: { text: string; grounding?: GroundingDto[] | null }) {
  const t = useT();
  const select = useAppStore((s) => s.select);
  if (!grounding || grounding.length === 0) return <>{text}</>;
  const byText = new Map(grounding.map((item) => [item.text, item]));

  const parts: Array<string | { code: string; item: GroundingDto | undefined }> = [];
  let last = 0;
  for (const match of text.matchAll(CODE_SPAN)) {
    if (match.index > last) parts.push(text.slice(last, match.index));
    parts.push({ code: match[1]!, item: byText.get(match[1]!.trim()) });
    last = match.index + match[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));

  return (
    <>
      {parts.map((part, index) => {
        if (typeof part === "string") return <Fragment key={index}>{part}</Fragment>;
        const { code, item } = part;
        if (item?.nodeId) {
          const nodeId = item.nodeId;
          return (
            <button
              key={index}
              type="button"
              onClick={() => select(nodeId)}
              title={t("在代码里对上了，点击查看")}
              className="mono rounded bg-[var(--color-surface-3)] px-1 text-[0.95em] text-[var(--color-accent)] underline-offset-2 hover:underline"
            >
              {code}
            </button>
          );
        }
        if (item?.missing) {
          return (
            <span
              key={index}
              title={t("代码里找不到这个名字，可能是模型编的")}
              className="mono rounded bg-[var(--color-danger)]/10 px-1 text-[0.95em] text-[var(--color-danger)] underline decoration-dotted underline-offset-2"
            >
              {code}
            </span>
          );
        }
        return (
          <span key={index} className="mono rounded bg-[var(--color-surface-3)] px-1 text-[0.95em]">
            {code}
          </span>
        );
      })}
    </>
  );
}

/** AI 文字里有几个名字在代码里找不到 */
export function missingCount(grounding: GroundingDto[] | null | undefined): number {
  return grounding?.filter((item) => item.missing).length ?? 0;
}
