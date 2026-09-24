import { loadConfig } from "../config.js";
import type { Db } from "../db/database.js";
import {
  getCallGraph,
  getFileDetail,
  getOverview,
  getScopeGraph,
  getScopeSummary,
  getSource,
  getSymbolDetail,
  ROOT_SCOPE,
} from "../db/queries.js";
import { getTrace } from "../db/traces.js";
import type {
  ChatContextItemDto,
  ChatDoneDto,
  ChatMessageDto,
  ChatRefDto,
  ChatRequestDto,
  GraphDto,
  LlmConfig,
  LlmUsage,
  RelationDto,
} from "../types.js";
import { mergeLlmStatusUsage } from "./cache.js";
import { OpenAiCompatibleClient, type ChatTurn, type LlmClientOptions } from "./client.js";
import { numberSourceLines, pseudocodeStepsToText } from "./format.js";

const MAX_MESSAGES = 24;
const MAX_MESSAGE_CHARS = 8_000;
const MAX_REFS_PER_MESSAGE = 12;
const MAX_QUOTE_CHARS = 2_000;
const MAX_EXPANDED_SCOPES = 4;
/** 整份上下文的字符预算；单个节点再各自限额，保证一次引用十个节点也不会被第一个吃光 */
const CONTEXT_BUDGET = 36_000;
const SYMBOL_SOURCE_CHARS = 9_000;
const FILE_SOURCE_CHARS = 12_000;
const QUOTE_SOURCE_LINES = 80;
const NODE_ID = /^(?:(?:sym|file):\d+|(?:dir|pkg):[^\n]{1,500})$/;

// ---------------------------------------------------------------------------
// 请求校验
// ---------------------------------------------------------------------------

/** 校验并裁剪浏览器发来的对话；不合法时返回 null。 */
export function parseChatRequest(raw: unknown): ChatRequestDto | null {
  if (!isRecord(raw) || !Array.isArray(raw["messages"])) return null;
  const messages: ChatMessageDto[] = [];
  for (const item of raw["messages"].slice(-MAX_MESSAGES)) {
    if (!isRecord(item)) return null;
    const role = item["role"];
    const content = item["content"];
    if ((role !== "user" && role !== "assistant") || typeof content !== "string") return null;
    const refs = Array.isArray(item["refs"])
      ? item["refs"].slice(0, MAX_REFS_PER_MESSAGE).map(parseRef).filter((ref): ref is ChatRefDto => ref !== null)
      : [];
    messages.push({ role, content: content.slice(0, MAX_MESSAGE_CHARS), refs });
  }
  const last = messages.at(-1);
  if (!last || last.role !== "user" || last.content.trim() === "") return null;
  return { messages };
}

function parseRef(raw: unknown): ChatRefDto | null {
  if (!isRecord(raw)) return null;
  if (raw["kind"] === "node") {
    return typeof raw["id"] === "string" && NODE_ID.test(raw["id"]) ? { kind: "node", id: raw["id"] } : null;
  }
  if (raw["kind"] === "quote") {
    const text = typeof raw["text"] === "string" ? raw["text"].trim().slice(0, MAX_QUOTE_CHARS) : "";
    if (text === "") return null;
    const nodeId = typeof raw["nodeId"] === "string" && NODE_ID.test(raw["nodeId"]) ? raw["nodeId"] : null;
    return { kind: "quote", text, nodeId, lines: lineRange(raw["lines"]) };
  }
  if (raw["kind"] === "view") {
    const mode = raw["mode"];
    if (mode !== "structure" && mode !== "callgraph" && mode !== "trace") return null;
    const scope = typeof raw["scope"] === "string" ? raw["scope"].slice(0, 500) : null;
    const expanded = Array.isArray(raw["expanded"])
      ? raw["expanded"].filter((id): id is string => typeof id === "string" && NODE_ID.test(id)).slice(0, 32)
      : null;
    const traceId = typeof raw["traceId"] === "string" && /^(?:trace:)?\d+$/.test(raw["traceId"]) ? raw["traceId"] : null;
    return { kind: "view", mode, scope, expanded, traceId };
  }
  return null;
}

function lineRange(raw: unknown): [number, number] | null {
  if (!Array.isArray(raw) || raw.length !== 2) return null;
  const [a, b] = raw;
  if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b < a) return null;
  return [a, b];
}

// ---------------------------------------------------------------------------
// 上下文组装
// ---------------------------------------------------------------------------

export interface ChatContext {
  text: string;
  items: ChatContextItemDto[];
}

interface Block {
  text: string;
  item: ChatContextItemDto;
}

/**
 * 把对话里引用到的节点组装成提示词上下文。
 *
 * 越新的消息引用的节点越靠前；视图只保留最新一份——旧视图描述的是用户
 * 已经离开的画面。超出预算的节点只列名字和 id，让模型知道它存在、并
 * 能提示用户单独追问。
 */
export function buildChatContext(db: Db, root: string, messages: ChatMessageDto[]): ChatContext {
  const lang = loadConfig(root).llm.outputLanguage;
  const blocks: Block[] = [];
  const skipped: string[] = [];
  let used = 0;

  const push = (block: Block | null) => {
    if (!block) return;
    blocks.push(block);
    used += block.text.length;
  };
  const remaining = () => CONTEXT_BUDGET - used;

  push(repoBlock(db, lang));

  const ordered = [...messages].reverse().flatMap((message) => message.refs ?? []);
  const view = ordered.find((ref): ref is Extract<ChatRefDto, { kind: "view" }> => ref.kind === "view");
  if (view) push(viewBlock(db, view, lang));

  const seen = new Set<string>();
  const nodeIds: string[] = [];
  const quoteSources: Array<{ nodeId: string; lines: [number, number] }> = [];
  for (const ref of ordered) {
    if (ref.kind === "node" && !seen.has(ref.id)) {
      seen.add(ref.id);
      nodeIds.push(ref.id);
    } else if (ref.kind === "quote" && ref.nodeId) {
      if (ref.lines && ref.nodeId.startsWith("file:")) quoteSources.push({ nodeId: ref.nodeId, lines: ref.lines });
      if (!seen.has(ref.nodeId)) {
        seen.add(ref.nodeId);
        nodeIds.push(ref.nodeId);
      }
    }
  }

  for (const source of quoteSources) {
    if (remaining() < 2_000) break;
    push(quoteSourceBlock(db, root, source.nodeId, source.lines, lang));
  }

  for (const id of nodeIds) {
    const budget = remaining();
    if (budget < 1_500) {
      skipped.push(id);
      continue;
    }
    push(nodeBlock(db, root, id, lang, budget));
  }

  if (skipped.length > 0) {
    const text = lang === "zh"
      ? `\n另有 ${skipped.length} 个引用因上下文长度未展开：${skipped.join("、")}。需要时请让用户单独追问。`
      : `\n${skipped.length} more references were omitted for length: ${skipped.join(", ")}. Ask the user to follow up on them separately if needed.`;
    blocks.push({ text, item: { label: lang === "zh" ? `另 ${skipped.length} 项未展开` : `${skipped.length} omitted`, detail: skipped.join(", ") } });
  }

  const heading = lang === "zh" ? "# 仓库上下文" : "# Repository context";
  return {
    text: `${heading}\n\n${blocks.map((block) => block.text).join("\n\n")}`,
    items: blocks.map((block) => block.item),
  };
}

function repoBlock(db: Db, lang: "zh" | "en"): Block {
  const overview = getOverview(db);
  const languages = overview.languages
    .slice(0, 6)
    .map((item) => `${item.language} ${Math.round(item.share * 100)}%`)
    .join(lang === "zh" ? "、" : ", ");
  const packages = overview.packages
    .slice(0, 16)
    .map((pkg) => `${pkg.name}（id=${pkg.id}，${pkg.dir}）`)
    .join(lang === "zh" ? "、" : ", ");
  const lines = lang === "zh"
    ? [
        `## 仓库 ${overview.repoName}（根目录 id=${ROOT_SCOPE}）`,
        `规模：${overview.totals.files} 个文件、${overview.totals.loc} 行、${overview.totals.symbols} 个符号；语言：${languages || "未知"}`,
        packages ? `包：${packages}` : "",
        overview.summary ? `AI 概览：${overview.summary}` : "",
      ]
    : [
        `## Repository ${overview.repoName} (root id=${ROOT_SCOPE})`,
        `Size: ${overview.totals.files} files, ${overview.totals.loc} lines, ${overview.totals.symbols} symbols; languages: ${languages || "unknown"}`,
        packages ? `Packages: ${packages}` : "",
        overview.summary ? `AI overview: ${overview.summary}` : "",
      ];
  return {
    text: lines.filter(Boolean).join("\n"),
    item: { label: overview.repoName, detail: lang === "zh" ? "仓库概况" : "Repository overview" },
  };
}

function viewBlock(db: Db, view: Extract<ChatRefDto, { kind: "view" }>, lang: "zh" | "en"): Block | null {
  const zh = lang === "zh";
  if (view.mode === "trace" && view.traceId) {
    const trace = getTrace(db, numericId(view.traceId));
    if (!trace) return null;
    const steps = trace.orderedSteps.map((step) => {
      const target = step.symbolId ?? step.fileId;
      const narrative = trace.narrative?.steps.find((item) => item.ordinal === step.ordinal)?.narrative;
      return `${step.ordinal}. ${step.label}（id=${target}，${step.filePath}:${step.line}，${step.kind}/${step.confidence}）${narrative ? ` — ${narrative}` : ""}`;
    });
    const text = [
      zh ? `## 用户正在看的关键链路：${trace.label}` : `## Trace the user is viewing: ${trace.label}`,
      zh
        ? `入口 ${trace.entry.label}（${trace.entry.kind}），终点是 ${trace.boundary.kind} 边界 ${trace.boundary.callee}`
        : `Entry ${trace.entry.label} (${trace.entry.kind}), ending at ${trace.boundary.kind} boundary ${trace.boundary.callee}`,
      trace.narrative?.summary ? `${zh ? "AI 叙述" : "AI narrative"}：${trace.narrative.summary}` : "",
      ...steps,
    ].filter(Boolean).join("\n");
    return { text, item: { label: zh ? "当前链路" : "Current trace", detail: `${trace.label} · ${steps.length} ${zh ? "步" : "steps"}` } };
  }

  if (view.mode === "callgraph" && view.scope?.startsWith("call:")) {
    const symbolId = Number(view.scope.slice(5));
    if (!Number.isInteger(symbolId)) return null;
    const graph = safeGraph(() => getCallGraph(db, { symbolId, depth: 1, limit: 16 }));
    if (!graph) return null;
    const center = graph.nodes.find((node) => node.focus)?.label ?? `sym:${symbolId}`;
    return {
      text: [
        zh ? `## 用户正在看的调用图：以 ${center}（id=sym:${symbolId}）为中心` : `## Call graph the user is viewing, centered on ${center} (id=sym:${symbolId})`,
        graphLines(graph, lang, 32, 40),
      ].join("\n"),
      item: { label: zh ? "当前调用图" : "Current call graph", detail: `${center} · ${graph.nodes.length} ${zh ? "个节点" : "nodes"}`, nodeId: `sym:${symbolId}` },
    };
  }

  const scope = view.scope && NODE_ID.test(view.scope) ? view.scope : ROOT_SCOPE;
  const graph = safeGraph(() => getScopeGraph(db, { scope, limit: 30 }));
  if (!graph) return null;
  const parts = [
    zh ? `## 用户正在看的结构图：作用域 ${scope}` : `## Structure view the user is viewing: scope ${scope}`,
    graphLines(graph, lang, 30, 30),
  ];
  for (const expanded of (view.expanded ?? []).slice(0, MAX_EXPANDED_SCOPES)) {
    const children = safeGraph(() => getScopeGraph(db, { scope: expanded, limit: 12 }));
    if (!children || children.nodes.length === 0) continue;
    parts.push(zh ? `### 已展开 ${expanded}` : `### Expanded ${expanded}`, graphLines(children, lang, 12, 0));
  }
  return {
    text: parts.join("\n"),
    item: { label: zh ? "当前视图" : "Current view", detail: `${scope === ROOT_SCOPE ? (zh ? "仓库根" : "root") : scope} · ${graph.nodes.length} ${zh ? "个节点" : "nodes"}` },
  };
}

function nodeBlock(db: Db, root: string, id: string, lang: "zh" | "en", budget: number): Block | null {
  if (id.startsWith("sym:")) return symbolBlock(db, root, Number(id.slice(4)), lang, budget);
  if (id.startsWith("file:")) return fileBlock(db, root, Number(id.slice(5)), lang, budget);
  return scopeBlock(db, id, lang);
}

function symbolBlock(db: Db, root: string, symbolId: number, lang: "zh" | "en", budget: number): Block | null {
  const detail = getSymbolDetail(db, symbolId);
  if (!detail) return null;
  const zh = lang === "zh";
  const name = detail.container ? `${detail.container}.${detail.name}` : detail.name;
  const header = [
    zh ? `## 符号 ${name}（id=${detail.id}）` : `## Symbol ${name} (id=${detail.id})`,
    `${detail.kind} · ${detail.filePath}（id=${detail.fileId}）L${detail.startLine}–${detail.endLine}` +
      `${detail.exported ? (zh ? " · 导出" : " · exported") : ""}${detail.isAsync ? " · async" : ""}`,
    detail.signature ? `${zh ? "签名" : "Signature"}：${detail.signature}` : "",
    detail.doc ? `${zh ? "文档注释" : "Doc comment"}：${detail.doc.slice(0, 800)}` : "",
    relationLine(zh ? "调用方（静态解析）" : "Callers (static)", detail.callers, 16, (r) =>
      zh ? `在 ${r.path}:${r.line} 调用` : `calls at ${r.path}:${r.line}`),
    relationLine(zh ? "调用（静态解析）" : "Callees (static)", detail.callees, 24, (r) =>
      zh ? `定义在 ${r.path}，本文件 L${r.line} 调用` : `defined in ${r.path}, called at L${r.line} of this file`),
    detail.externalCallees.length > 0
      ? `${zh ? "外部调用" : "External calls"}：${detail.externalCallees.slice(0, 16).map((c) => `${c.name}×${c.count}`).join(", ")}`
      : "",
    detail.typeRelations.length > 0
      ? `${zh ? "类型关系" : "Type relations"}：${detail.typeRelations.map((r) => `${r.relation} ${r.target}${r.targetId ? `（id=sym:${r.targetId}）` : ""}`).join(", ")}`
      : "",
    detail.summary ? `${zh ? "AI 解释" : "AI explanation"}：\n${detail.summary}` : "",
    detail.pseudocodeSteps?.length
      ? `${zh ? "AI 伪代码" : "AI pseudocode"}：\n${pseudocodeStepsToText(detail.pseudocodeSteps)}`
      : "",
  ].filter(Boolean).join("\n");

  const sourceBudget = Math.min(SYMBOL_SOURCE_CHARS, budget - header.length - 200);
  const slice = sourceBudget > 400
    ? getSource(db, root, numericId(detail.fileId), detail.startLine, detail.endLine)
    : null;
  const source = slice ? numberSourceLines(slice.code, slice.startLine, sourceBudget) : "";
  const shownLines = source === "" ? 0 : source.split("\n").length;
  const text = source === ""
    ? header
    : `${header}\n${sourceHeading(lang, shownLines < slice!.endLine - slice!.startLine + 1)}\n\`\`\`${slice!.language}\n${source}\n\`\`\``;
  return {
    text,
    item: {
      label: name,
      detail: [
        detail.kind,
        shownLines > 0 ? (zh ? `源码 ${shownLines} 行` : `${shownLines} source lines`) : "",
        zh ? `${detail.callers.length} 调用方` : `${detail.callers.length} callers`,
      ].filter(Boolean).join(" · "),
      nodeId: detail.id,
    },
  };
}

function fileBlock(db: Db, root: string, fileId: number, lang: "zh" | "en", budget: number): Block | null {
  const detail = getFileDetail(db, fileId);
  if (!detail) return null;
  const zh = lang === "zh";
  const symbols = detail.symbols
    .slice(0, 48)
    .map((s) => `${s.container ? `${s.container}.` : ""}${s.name}（id=${s.id}，${s.kind}，L${s.startLine}–${s.endLine}）`)
    .join(", ");
  const imports = detail.imports
    .slice(0, 24)
    .map((item) => item.targetPath ?? item.source)
    .join(", ");
  const importedBy = detail.importedBy
    .slice(0, 16)
    .map((item) => `${item.path}（id=${item.id}）`)
    .join(", ");
  const header = [
    zh ? `## 文件 ${detail.path}（id=${detail.id}）` : `## File ${detail.path} (id=${detail.id})`,
    `${detail.language} · ${detail.role} · ${detail.loc} LOC${detail.packageName ? ` · ${zh ? "包" : "package"} ${detail.packageName}` : ""}`,
    symbols ? `${zh ? "符号" : "Symbols"}：${symbols}` : "",
    imports ? `${zh ? "导入" : "Imports"}：${imports}` : "",
    importedBy ? `${zh ? "被这些文件导入" : "Imported by"}：${importedBy}` : "",
    detail.summary ? `${zh ? "AI 解释" : "AI explanation"}：\n${detail.summary}` : "",
    detail.pseudocodeSteps?.length
      ? `${zh ? "AI 伪代码" : "AI pseudocode"}：\n${pseudocodeStepsToText(detail.pseudocodeSteps)}`
      : "",
  ].filter(Boolean).join("\n");

  const sourceBudget = Math.min(FILE_SOURCE_CHARS, budget - header.length - 200);
  const slice = sourceBudget > 400 ? getSource(db, root, fileId) : null;
  const source = slice ? numberSourceLines(slice.code, 1, sourceBudget) : "";
  const shownLines = source === "" ? 0 : source.split("\n").length;
  const text = source === ""
    ? header
    : `${header}\n${sourceHeading(lang, shownLines < slice!.endLine)}\n\`\`\`${slice!.language}\n${source}\n\`\`\``;
  return {
    text,
    item: {
      label: detail.path.split("/").at(-1) ?? detail.path,
      detail: [
        zh ? "文件" : "file",
        shownLines > 0 ? (zh ? `源码 ${shownLines}/${detail.loc} 行` : `${shownLines}/${detail.loc} source lines`) : "",
        zh ? `${detail.symbols.length} 个符号` : `${detail.symbols.length} symbols`,
      ].filter(Boolean).join(" · "),
      nodeId: detail.id,
    },
  };
}

function scopeBlock(db: Db, id: string, lang: "zh" | "en"): Block | null {
  const graph = safeGraph(() => getScopeGraph(db, { scope: id, limit: 24 }));
  if (!graph) return null;
  const zh = lang === "zh";
  const summary = getScopeSummary(db, id);
  const kind = id.startsWith("pkg:") ? (zh ? "包" : "Package") : zh ? "目录" : "Directory";
  const label = id === ROOT_SCOPE ? (zh ? "仓库根" : "root") : id.slice(4);
  return {
    text: [
      `## ${kind} ${label}（id=${id}）`,
      summary ? `${zh ? "AI 摘要" : "AI summary"}：${summary}` : "",
      graphLines(graph, lang, 24, 24),
    ].filter(Boolean).join("\n"),
    item: {
      label: label.split("/").at(-1) || label,
      detail: `${kind} · ${graph.nodes.length} ${zh ? "个子节点" : "children"}`,
      nodeId: id,
    },
  };
}

function quoteSourceBlock(
  db: Db, root: string, nodeId: string, lines: [number, number], lang: "zh" | "en",
): Block | null {
  const end = Math.min(lines[1], lines[0] + QUOTE_SOURCE_LINES - 1);
  const slice = getSource(db, root, numericId(nodeId), lines[0], end);
  if (!slice || slice.code === "") return null;
  const zh = lang === "zh";
  return {
    text: `## ${zh ? "用户引用的源码" : "Source the user quoted"} ${slice.path} L${slice.startLine}–${slice.endLine}（id=${nodeId}）\n` +
      `\`\`\`${slice.language}\n${numberSourceLines(slice.code, slice.startLine, 8_000)}\n\`\`\``,
    item: { label: slice.path.split("/").at(-1) ?? slice.path, detail: `L${slice.startLine}–${slice.endLine}`, nodeId },
  };
}

function graphLines(graph: GraphDto, lang: "zh" | "en", nodeLimit: number, edgeLimit: number): string {
  const zh = lang === "zh";
  const labels = new Map(graph.nodes.map((node) => [node.id, node.label]));
  const nodes = graph.nodes.slice(0, nodeLimit).map((node) => {
    const kind = node.symbolKind ?? node.kind;
    const size = node.kind === "symbol" ? `L${node.metrics.loc}` : `${node.metrics.files} ${zh ? "文件" : "files"}/${node.metrics.loc} LOC`;
    const summary = node.summary ? ` — ${node.summary.slice(0, 160)}` : "";
    return `- ${node.label}（id=${node.id}，${kind}，${size}）${summary}`;
  });
  if (graph.nodes.length > nodeLimit || graph.truncated > 0) {
    nodes.push(zh ? `- ……另有 ${graph.nodes.length - Math.min(nodeLimit, graph.nodes.length) + graph.truncated} 项` : `- …and ${graph.nodes.length - Math.min(nodeLimit, graph.nodes.length) + graph.truncated} more`);
  }
  const edges = [...graph.edges]
    .sort((a, b) => b.count - a.count)
    .slice(0, edgeLimit)
    .map((edge) => `${labels.get(edge.source) ?? edge.source} → ${labels.get(edge.target) ?? edge.target}（${edge.type}×${edge.count}，${edge.confidence}）`);
  return [
    ...nodes,
    edges.length > 0 ? `${zh ? "主要关系（静态解析）" : "Main relations (static)"}：\n${edges.join("\n")}` : "",
  ].filter(Boolean).join("\n");
}

/** RelationDto 的 path 是对方所在文件，line 却是调用点（在调用方文件里），位置描述由调用处决定 */
function relationLine(
  label: string,
  relations: RelationDto[],
  limit: number,
  where: (relation: RelationDto) => string,
): string {
  if (relations.length === 0) return "";
  const shown = relations
    .slice(0, limit)
    .map((r) => `${r.name}（id=${r.id}，${where(r)}${r.confidence === "exact" ? "" : `，${r.confidence}`}）`);
  const more = relations.length > limit ? ` …+${relations.length - limit}` : "";
  return `${label}：${shown.join(", ")}${more}`;
}

function sourceHeading(lang: "zh" | "en", truncated: boolean): string {
  if (lang === "zh") return `源码（每行开头的「行号| 」是绝对行号，不属于代码${truncated ? "；超出长度的部分已截断" : ""}）：`;
  return `Source (the leading "N| " is the absolute line number, not code${truncated ? "; truncated for length" : ""}):`;
}

/** `sym:12` / `file:3` / `trace:7` / `7` → 7 */
function numericId(id: string): number {
  return Number(id.slice(id.indexOf(":") + 1));
}

function safeGraph(build: () => GraphDto): GraphDto | null {
  try {
    return build();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 对话
// ---------------------------------------------------------------------------

export interface ChatStreamHandlers {
  signal?: AbortSignal | undefined;
  onContext?: ((items: ChatContextItemDto[]) => void) | undefined;
  onDelta: (text: string) => void;
  client?: LlmClientOptions | undefined;
}

export async function streamRepositoryChat(
  db: Db,
  root: string,
  request: ChatRequestDto,
  handlers: ChatStreamHandlers,
): Promise<ChatDoneDto> {
  const config = loadConfig(root).llm;
  const requestConfig = chatConfig(config);
  const client = new OpenAiCompatibleClient(requestConfig, handlers.client);
  const context = buildChatContext(db, root, request.messages);
  handlers.onContext?.(context.items);

  const turns: ChatTurn[] = [
    { role: "system", content: `${chatSystem(config.outputLanguage)}\n\n${context.text}` },
    ...request.messages.map((message) => ({
      role: message.role,
      content: message.role === "user" ? withQuotes(message, config.outputLanguage) : message.content,
    })),
  ];
  const result = await client.streamChat(turns, { signal: handlers.signal, onDelta: handlers.onDelta });
  return { model: requestConfig.model, usage: result.usage };
}

/** 把追问的用量记进仓库的 LLM 状态，和扫描、按需生成共用一份计数。 */
export function recordChatUsage(db: Db, root: string, usage: LlmUsage): void {
  const config = loadConfig(root).llm;
  mergeLlmStatusUsage(db, {
    enabled: true, available: true, model: config.model, interactiveModel: config.interactiveModel,
    reason: null, usage,
  });
}

function withQuotes(message: ChatMessageDto, lang: "zh" | "en"): string {
  const quotes = (message.refs ?? []).filter((ref): ref is Extract<ChatRefDto, { kind: "quote" }> => ref.kind === "quote");
  if (quotes.length === 0) return message.content;
  const blocks = quotes.map((quote) => {
    const origin = [quote.nodeId ? `id=${quote.nodeId}` : "", quote.lines ? `L${quote.lines[0]}–${quote.lines[1]}` : ""]
      .filter(Boolean)
      .join(" ");
    const heading = lang === "zh" ? `[引用${origin ? ` · ${origin}` : ""}]` : `[Quote${origin ? ` · ${origin}` : ""}]`;
    return `${heading}\n${quote.text.split("\n").map((line) => `> ${line}`).join("\n")}`;
  });
  return `${blocks.join("\n\n")}\n\n${message.content}`;
}

function chatConfig(config: LlmConfig): LlmConfig {
  return {
    ...config,
    ...(config.interactiveModel === null ? {} : { model: config.interactiveModel }),
  };
}

function chatSystem(lang: "zh" | "en"): string {
  if (lang === "en") {
    return [
      "You are the code assistant built into RepoLens. The user is exploring a repository in a visual map and asks follow-up questions about what they see.",
      "Rules:",
      "1. Answer only from the repository context below and the conversation. If something is not in the context, say so and suggest the user select the relevant node on the canvas (or click a link in your answer) and ask again. Never invent files, functions or behavior.",
      "2. Separate facts from inference: calls, imports and signatures come from static analysis and are facts; AI explanations and pseudocode are model-generated, so say so when relying on them; runtime behavior can only be described as likely.",
      "3. When you mention a symbol, file, directory or package that appears in the context, write it as a Markdown link [display name](node:ID), copying ID exactly from an id=… field in the context. Never make up an ID.",
      "4. Cite concrete code as path:line. Show code only in fenced blocks with a language tag, and only the few lines that matter.",
      "5. Answer in English. Lead with the conclusion, then details; be concise and don't restate the context unless asked.",
    ].join("\n");
  }
  return [
    "你是 RepoLens 内置的代码助手。用户正在可视化画布里浏览一个代码仓库，并就眼前看到的内容追问你。",
    "规则：",
    "1. 只依据下面的「仓库上下文」和对话内容回答。上下文里没有的信息就直说没看到，并建议用户在画布上选中相关节点（或点击回答里的链接）后再问；不要编造文件、函数或行为。",
    "2. 区分事实与推断：调用、导入、签名来自静态解析，可以当作事实；AI 解释和伪代码是模型生成的，依据它们时要说明；运行时行为只能说「可能」。",
    "3. 提到上下文中出现的符号、文件、目录或包时，写成 Markdown 链接 [显示名](node:ID)，ID 必须原样复制上下文里 id=… 的值，不得自行拼造。",
    "4. 引用具体代码时注明 路径:行号；展示代码只用带语言标记的代码块，并只摘录关键的几行。",
    "5. 用简体中文回答，先给结论再展开，保持简洁；除非用户要求，不要复述上下文。",
  ].join("\n");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
