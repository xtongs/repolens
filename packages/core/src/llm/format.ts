/** AI 文本在写入缓存和读取旧缓存时共用的确定性格式化。 */

export type SemanticTextFlavor =
  | "summary"
  | "summary-v2"
  | "tooltip-summary"
  | "pseudocode"
  | "narrative";

interface StructuredSummary {
  purpose?: unknown;
  keyConcepts?: unknown;
  workflow?: unknown;
  notes?: unknown;
}

interface StructuredPseudocodeStep {
  step?: unknown;
  details?: unknown;
}

export function normalizeSemanticContent(
  value: string,
  flavor: SemanticTextFlavor,
  lang: "zh" | "en" = "zh",
): string {
  switch (flavor) {
    case "summary":
      return cleanText(value, 12_000) ?? "";
    case "summary-v2":
      return normalizeSummary(value, 12_000, lang) ?? "";
    case "tooltip-summary":
      return cleanSingleLine(value, 240) ?? "";
    case "pseudocode":
      return normalizePseudocode(value, 16_000) ?? "";
    // narrative 是 JSON 字符串，不能在解析前改写反斜杠。
    case "narrative":
      return value;
  }
}

export function cleanText(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const text = normalizeRawText(value).replace(/[ \t]+$/gm, "").trim();
  return text === "" ? null : text.slice(0, maxLength);
}

export function cleanSingleLine(value: unknown, maxLength: number): string | null {
  const text = cleanText(value, Math.max(maxLength * 4, maxLength));
  if (text === null) return null;
  const compact = text
    .replace(/\s+/g, " ")
    .replace(/^(用途|Purpose)\s*[:：]\s*/i, "")
    .trim();
  const cjkSentence = /^(.+?[。！？])/.exec(compact)?.[1];
  const latinSentence = /^(.+?[.!?])(?:\s|$)/.exec(compact)?.[1];
  const sentence = cjkSentence ?? latinSentence ?? compact;
  return sentence === "" ? null : sentence.slice(0, maxLength);
}

/** 摘要固定成具名短段落，并修复兼容接口留下的字面量换行。 */
export function normalizeSummary(
  value: unknown,
  maxLength: number,
  lang: "zh" | "en" = "zh",
): string | null {
  if (isRecord(value)) return normalizeStructuredSummary(value, maxLength, lang);
  const raw = cleanText(value, maxLength * 2);
  if (raw === null) return null;
  let text = stripCodeFence(raw);
  const headings: Array<[RegExp, string]> = lang === "zh"
    ? [
        [/(?:#{1,6}\s*)?(?:\*\*)?用途\s*[:：](?:\*\*)?/gi, "用途："],
        [/(?:#{1,6}\s*)?(?:\*\*)?核心概念\s*[:：](?:\*\*)?/gi, "核心概念："],
        [/(?:#{1,6}\s*)?(?:\*\*)?工作方式\s*[:：](?:\*\*)?/gi, "工作方式："],
        [/(?:#{1,6}\s*)?(?:\*\*)?使用提示\s*[:：](?:\*\*)?/gi, "使用提示："],
      ]
    : [
        [/(?:#{1,6}\s*)?(?:\*\*)?Purpose\s*:(?:\*\*)?/gi, "Purpose:"],
        [/(?:#{1,6}\s*)?(?:\*\*)?Key concepts\s*:(?:\*\*)?/gi, "Key concepts:"],
        [/(?:#{1,6}\s*)?(?:\*\*)?How it works\s*:(?:\*\*)?/gi, "How it works:"],
        [/(?:#{1,6}\s*)?(?:\*\*)?Usage notes\s*:(?:\*\*)?/gi, "Usage notes:"],
      ];
  for (const [pattern, heading] of headings) text = text.replace(pattern, "\n\n" + heading);
  let paragraphs = text
    .replace(/^\s+/, "")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  const purposeHeading = lang === "zh" ? "用途：" : "Purpose: ";
  const knownHeadings = lang === "zh"
    ? /^(用途|核心概念|工作方式|使用提示)[：:]/
    : /^(Purpose|Key concepts|How it works|Usage notes):/i;
  if (paragraphs[0] && !knownHeadings.test(paragraphs[0])) {
    paragraphs[0] = purposeHeading + paragraphs[0];
  }
  paragraphs = paragraphs.map((paragraph) => formatSummaryParagraph(paragraph, lang));
  const normalized = mergeSummaryParagraphs(paragraphs, lang);
  return normalized === "" ? null : normalized.slice(0, maxLength);
}

/** 顶层步骤连续编号，子步骤固定使用两个空格和短横线。 */
export function normalizePseudocode(
  value: unknown,
  maxLength: number,
  maxLines = 32,
): string | null {
  const rawLines = Array.isArray(value)
    ? structuredPseudocodeLines(value)
    : pseudocodeStringLines(value, maxLength);
  if (rawLines === null || rawLines.length === 0) return null;

  const limited = rawLines.slice(0, maxLines);
  const indents = limited.map((line) => line.match(/^ */)?.[0].length ?? 0);
  const commonIndent = Math.min(...indents);
  let ordinal = 0;
  const lines = limited.map((line, index) => {
    const indent = Math.max(0, (indents[index] ?? 0) - commonIndent);
    const content = line
      .trim()
      .replace(/^#{1,6}\s+/, "")
      .replace(/^(?:[-*•]\s+|\d+[.)、]\s*)/, "")
      .trim();
    if (indent === 0) {
      ordinal++;
      return String(ordinal) + ". " + content;
    }
    const depth = Math.min(4, Math.max(1, Math.ceil(indent / 2)));
    return "  ".repeat(depth) + "- " + content;
  });
  const normalized = lines.join("\n");
  return normalized === "" ? null : normalized.slice(0, maxLength);
}

function normalizeStructuredSummary(
  value: StructuredSummary,
  maxLength: number,
  lang: "zh" | "en",
): string | null {
  const labels = summaryLabels(lang);
  const purposeParts = splitPurpose(cleanText(value.purpose, 2_000), lang);
  const concepts = stringList(value.keyConcepts, 8);
  const workflow = [
    ...(purposeParts.implementation ? [purposeParts.implementation] : []),
    ...stringList(value.workflow, 10),
  ];
  const notes = stringList(value.notes, 6);
  const paragraphs = [
    purposeParts.purpose ? labels.purpose + purposeParts.purpose : null,
    concepts.length > 0
      ? labels.concepts + "\n" + concepts.map((item) => "- " + item).join("\n")
      : null,
    workflow.length > 0
      ? labels.workflow + "\n" + workflow.map((item, index) => String(index + 1) + ". " + item).join("\n")
      : null,
    notes.length > 0
      ? labels.notes + "\n" + notes.map((item) => "- " + item).join("\n")
      : null,
  ].filter((item): item is string => item !== null);
  const normalized = paragraphs.join("\n\n");
  return normalized === "" ? null : normalized.slice(0, maxLength);
}

function formatSummaryParagraph(paragraph: string, lang: "zh" | "en"): string {
  const labels = summaryLabels(lang);
  const patterns: Array<[RegExp, string, "plain" | "bullets" | "steps"]> = lang === "zh"
    ? [
        [/^用途[：:]\s*/i, labels.purpose, "plain"],
        [/^核心概念[：:]\s*/i, labels.concepts, "bullets"],
        [/^工作方式[：:]\s*/i, labels.workflow, "steps"],
        [/^使用提示[：:]\s*/i, labels.notes, "bullets"],
      ]
    : [
        [/^Purpose:\s*/i, labels.purpose, "plain"],
        [/^Key concepts:\s*/i, labels.concepts, "bullets"],
        [/^How it works:\s*/i, labels.workflow, "steps"],
        [/^Usage notes:\s*/i, labels.notes, "bullets"],
      ];
  for (const [pattern, label, style] of patterns) {
    if (!pattern.test(paragraph)) continue;
    const body = paragraph.replace(pattern, "").trim();
    if (style === "plain") {
      const parts = splitPurpose(collapseLines(body), lang);
      if (parts.implementation) {
        return label + parts.purpose + "\n\n" + labels.workflow + "\n1. " + parts.implementation;
      }
      return label + (parts.purpose ?? "");
    }
    const items = summaryItems(body, lang);
    if (items.length === 0) return label;
    const lines = style === "steps"
      ? items.map((item, index) => String(index + 1) + ". " + item)
      : items.map((item) => "- " + item);
    return label + "\n" + lines.join("\n");
  }
  return collapseLines(paragraph);
}

/** 同类段落合并后按固定顺序输出，避免旧缓存产生两个“工作方式”。 */
function mergeSummaryParagraphs(paragraphs: readonly string[], lang: "zh" | "en"): string {
  const labels = summaryLabels(lang);
  const purpose: string[] = [];
  const concepts: string[] = [];
  const workflow: string[] = [];
  const notes: string[] = [];
  const patterns: Array<[RegExp, string[]]> = lang === "zh"
    ? [
        [/^用途[：:]\s*/i, purpose],
        [/^核心概念[：:]\s*/i, concepts],
        [/^工作方式[：:]\s*/i, workflow],
        [/^使用提示[：:]\s*/i, notes],
      ]
    : [
        [/^Purpose:\s*/i, purpose],
        [/^Key concepts:\s*/i, concepts],
        [/^How it works:\s*/i, workflow],
        [/^Usage notes:\s*/i, notes],
      ];

  for (const block of paragraphs.flatMap((paragraph) => paragraph.split(/\n{2,}/))) {
    const trimmed = block.trim();
    let matched = false;
    for (const [pattern, target] of patterns) {
      if (!pattern.test(trimmed)) continue;
      const body = trimmed.replace(pattern, "").trim();
      if (target === purpose) {
        const text = collapseLines(body);
        if (text) target.push(text);
      } else {
        target.push(...summaryItems(body, lang));
      }
      matched = true;
      break;
    }
    if (!matched) {
      const text = collapseLines(trimmed);
      if (text) purpose.push(text);
    }
  }

  const sections = [
    purpose.length > 0 ? labels.purpose + unique(purpose).join(" ") : null,
    concepts.length > 0
      ? labels.concepts + "\n" + unique(concepts).slice(0, 8).map((item) => "- " + item).join("\n")
      : null,
    workflow.length > 0
      ? labels.workflow + "\n" + unique(workflow).slice(0, 12)
          .map((item, index) => String(index + 1) + ". " + item).join("\n")
      : null,
    notes.length > 0
      ? labels.notes + "\n" + unique(notes).slice(0, 8).map((item) => "- " + item).join("\n")
      : null,
  ].filter((item): item is string => item !== null);
  return sections.join("\n\n");
}

function summaryItems(value: string, lang: "zh" | "en"): string[] {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  const explicitlyListed = lines.length > 1 || lines.some((line) => /^(?:[-*•]|\d+[.)、])\s*/.test(line));
  const source = explicitlyListed ? lines : value.split(lang === "zh" ? /；/ : /;\s+/);
  return source
    .map((item) => item.trim().replace(/^(?:[-*•]|\d+[.)、])\s*/, "").trim())
    .filter(Boolean);
}

function collapseLines(value: string): string {
  return value.replace(/\s*\n\s*/g, " ").replace(/ {2,}/g, " ").trim();
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function summaryLabels(lang: "zh" | "en") {
  return lang === "zh"
    ? { purpose: "用途：", concepts: "核心概念：", workflow: "工作方式：", notes: "使用提示：" }
    : { purpose: "Purpose: ", concepts: "Key concepts:", workflow: "How it works:", notes: "Usage notes:" };
}

function splitPurpose(value: string | null, lang: "zh" | "en"): {
  purpose: string | null;
  implementation: string | null;
} {
  if (!value) return { purpose: null, implementation: null };
  const prefix = lang === "zh" ? /^为什么需要\s*[：:]\s*/ : /^Why(?: it is)? needed\s*:\s*/i;
  const text = value.replace(prefix, "");
  const marker = lang === "zh" ? /[。.!?]\s*如何实现\s*[：:]\s*/ : /[.!?]\s*How it works\s*:\s*/i;
  const match = marker.exec(text);
  if (!match || match.index === undefined) return { purpose: text.trim(), implementation: null };
  const purpose = text.slice(0, match.index + 1).trim();
  const implementation = text.slice(match.index + match[0].length).trim();
  return { purpose, implementation: implementation || null };
}

function structuredPseudocodeLines(value: unknown[]): string[] {
  const lines: string[] = [];
  for (const raw of value) {
    if (typeof raw === "string") {
      const step = cleanText(raw, 1_000);
      if (step) lines.push(step);
      continue;
    }
    if (!isRecord(raw)) continue;
    const step = cleanText((raw as StructuredPseudocodeStep).step, 1_000);
    if (!step) continue;
    lines.push(step);
    for (const detail of stringList((raw as StructuredPseudocodeStep).details, 8)) {
      lines.push("  " + detail);
    }
  }
  return lines;
}

function pseudocodeStringLines(value: unknown, maxLength: number): string[] | null {
  const raw = cleanText(value, maxLength * 2);
  if (raw === null) return null;
  return stripCodeFence(raw)
    .replace(/\t/g, "  ")
    .split("\n")
    .filter((line) => line.trim() !== "");
}

function stringList(value: unknown, limit: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => cleanText(item, 1_000))
    .filter((item): item is string => item !== null)
    .slice(0, limit);
}

function normalizeRawText(value: string): string {
  let text = decodeHtmlEntities(value).replace(/\r\n?/g, "\n");
  // 某些兼容接口会对 JSON 字符串二次转义，最终留下可见的反斜杠+n。
  // 只在整段没有真实换行，或有多个转义换行时恢复，避免误伤伪代码里
  // 用来说明字符串字面量的单个 `\n`。
  const escapedBreaks = text.match(/\\r\\n|\\n|\\r/g)?.length ?? 0;
  if (escapedBreaks > 0 && (!text.includes("\n") || escapedBreaks > 1)) {
    text = text
      .replace(/\\r\\n/g, "\n")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\n");
  }
  return text;
}

function stripCodeFence(value: string): string {
  const fence = String.fromCharCode(96).repeat(3);
  const lines = value.split("\n");
  if (lines[0]?.trim().startsWith(fence)) lines.shift();
  if (lines.at(-1)?.trim() === fence) lines.pop();
  return lines.join("\n").trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只解码明确的字符实体，不把 AI 文本当作 HTML 解析。 */
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'",
  };
  return value
    .replace(
      /&#(?:x([0-9a-f]+)|([0-9]+));/gi,
      (entity, hex: string | undefined, decimal: string | undefined) => {
        const codePoint = Number.parseInt(hex ?? decimal ?? "", hex === undefined ? 10 : 16);
        return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff &&
          !(codePoint >= 0xd800 && codePoint <= 0xdfff)
          ? String.fromCodePoint(codePoint)
          : entity;
      },
    )
    .replace(
      /&(nbsp|amp|lt|gt|quot|apos);/gi,
      (entity, name: string) => named[name.toLowerCase()] ?? entity,
    );
}
