import { useMemo, useState } from "react";
import { useT } from "../i18n";
import { shikiLanguage, useHighlightedLines } from "../lib/highlight";
import { type CodeMark, CodeLine } from "../ui/CodeLines";
import { MAX_SIGNATURE, commonIndent, declarationHeader, sliceTokens } from "./declaration";
import { useSource } from "./useSource";

/** 声明头超过这么多行只露开头，概览里不该被一个类型定义占满 */
const MAX_HEADER_LINES = 12;

/** 索引里存的签名（压成一行）按语言高亮，长了在容器内折行 */
export function SignatureText({
  code, path, language, marks,
}: {
  code: string;
  path: string;
  language?: string | null;
  marks?: readonly CodeMark[];
}) {
  const tokens = useHighlightedLines(code, shikiLanguage(language, path));
  return <CodeLine number={null} text={code} tokens={tokens?.[0]} marks={marks} wrap />;
}

/**
 * 符号的声明头，取源码原文：保留作者的换行和缩进，带高亮，函数体之前截断。
 * 源码读不到或和索引对不上（文件在扫描后改过）时退回压成一行的签名。
 */
export function DeclarationHeader({
  fileId, startLine, endLine, signature, path, language,
}: {
  fileId: string;
  startLine: number;
  endLine: number;
  signature: string;
  path: string;
  language: string;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  // 和源码、伪代码标签页同一组参数，切过去不用再请求
  const { source, error } = useSource(fileId, startLine, endLine);
  const header = useMemo(() => {
    if (!source) return null;
    const part = source.range(startLine, endLine);
    const found = declarationHeader(part.lines, signature);
    if (!found) return null;
    const lines = part.lines.slice(0, found.count);
    const tokens = part.tokens?.slice(0, found.count) ?? null;
    const last = lines.length - 1;
    lines[last] = (lines[last] as string).slice(0, found.lastColumn);
    if (tokens) tokens[last] = sliceTokens(tokens[last] ?? [], 0, found.lastColumn);
    const indent = commonIndent(lines);
    return {
      lines: lines.map((line) => line.slice(indent)),
      tokens: tokens?.map((line) => sliceTokens(line, indent)) ?? null,
    };
  }, [source, startLine, endLine, signature]);

  if (!source && !error) return null;
  if (!header) {
    return <Frame><SignatureText code={signature} path={path} language={language} /></Frame>;
  }
  const shown = expanded ? header.lines : header.lines.slice(0, MAX_HEADER_LINES);
  const hidden = header.lines.length - shown.length;
  return (
    <Frame>
      {shown.map((line, index) => (
        <CodeLine key={index} number={null} text={line} tokens={header.tokens?.[index]} wrap />
      ))}
      {hidden > 0 ? (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="mono text-[11px] leading-[1.6] text-[var(--color-ink-faint)] hover:text-[var(--color-accent)]"
        >
          {t("… 还有 {count} 行", { count: hidden })}
        </button>
      ) : signature.length >= MAX_SIGNATURE ? (
        <div className="mono text-[11px] leading-[1.6] text-[var(--color-ink-faint)]">…</div>
      ) : null}
    </Frame>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-2.5 rounded-md border border-[var(--color-line)] bg-[var(--color-surface-2)] px-2.5 py-1.5">
      {children}
    </div>
  );
}
