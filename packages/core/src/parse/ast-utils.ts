import type { Node as TsNode } from "web-tree-sitter";
import type { CallKind, ParsedCall, ParsedSymbol } from "../types.js";

/** 深度优先前序遍历；visitor 返回 false 表示不再深入该节点 */
export function walk(node: TsNode, visitor: (n: TsNode) => boolean | void): void {
  const stack: TsNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as TsNode;
    if (visitor(current) === false) continue;
    for (let i = current.namedChildCount - 1; i >= 0; i--) {
      const child = current.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

/** 遍历包含匿名节点的全部子节点，取修饰符/关键字时需要 */
export function walkAll(node: TsNode, visitor: (n: TsNode) => boolean | void): void {
  const stack: TsNode[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as TsNode;
    if (visitor(current) === false) continue;
    for (let i = current.childCount - 1; i >= 0; i--) {
      const child = current.child(i);
      if (child) stack.push(child);
    }
  }
}

export function namedChildren(node: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

/**
 * 调用参数的源码文本。只保留前 12 个、单项最多 240 字符：路由路径和处理器名
 * 通常都在最前面，设上限可避免把大对象字面量复制进 SQLite。
 */
export function argumentTexts(
  argsNode: TsNode | null,
  commentTypes: ReadonlySet<string> = new Set(["comment", "line_comment", "block_comment"]),
): string[] {
  if (!argsNode) return [];
  return namedChildren(argsNode)
    .filter((child) => !commentTypes.has(child.type))
    .slice(0, 12)
    .map((child) => normalizeWhitespace(child.text).slice(0, 240));
}

export function childrenOfType(node: TsNode, type: string): TsNode[] {
  return namedChildren(node).filter((c) => c.type === type);
}

export function firstOfType(node: TsNode, ...types: string[]): TsNode | null {
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child && types.includes(child.type)) return child;
  }
  return null;
}

export function fieldNode(node: TsNode, field: string): TsNode | null {
  return node.childForFieldName(field) ?? null;
}

export function fieldText(node: TsNode, field: string): string | null {
  return node.childForFieldName(field)?.text ?? null;
}

/** 1-based 行号 */
export function lineOf(node: TsNode): number {
  return node.startPosition.row + 1;
}

/** 找到最近的指定类型祖先 */
export function ancestorOfType(node: TsNode, types: readonly string[]): TsNode | null {
  let current: TsNode | null = node.parent;
  while (current) {
    if (types.includes(current.type)) return current;
    current = current.parent;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 签名与文档
// ---------------------------------------------------------------------------

const MAX_SIGNATURE = 400;

/**
 * 取函数声明的签名原文：从声明起点到函数体起点之间的文本。
 * 直接用原文而不是重新拼装，是为了在详情面板里保留开发者写的类型标注原貌。
 */
export function signatureOf(node: TsNode, bodyFields: readonly string[] = ["body"]): string {
  let bodyStart = node.endIndex;
  for (const field of bodyFields) {
    const body = node.childForFieldName(field);
    if (body) {
      bodyStart = Math.min(bodyStart, body.startIndex);
    }
  }
  const raw = node.text.slice(0, bodyStart - node.startIndex);
  return normalizeWhitespace(raw).slice(0, MAX_SIGNATURE);
}

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * 收集紧邻声明上方的注释块。
 *
 * 判定「紧邻」的标准是行号连续：中间空一行就认为注释不属于这个声明，
 * 这和多数语言的文档注释约定一致，也避免把文件头注释错挂到第一个函数上。
 */
export function docCommentAbove(node: TsNode, commentTypes: readonly string[]): string | undefined {
  const lines: string[] = [];
  let cursor: TsNode | null = node.previousSibling;
  let expectedEndRow = node.startPosition.row - 1;

  while (cursor && commentTypes.includes(cursor.type)) {
    if (visualEndRow(cursor) !== expectedEndRow) break;
    lines.unshift(cursor.text);
    expectedEndRow = cursor.startPosition.row - 1;
    cursor = cursor.previousSibling;
  }

  if (lines.length === 0) return undefined;
  return cleanComment(lines.join("\n")).slice(0, 1000) || undefined;
}

/**
 * 节点视觉上的最后一行。
 *
 * 区间止于某行第 0 列时，它其实结束在上一行的行尾——tree-sitter-rust 的
 * `line_comment` 就把行尾换行算进了自己的范围。直接拿 `endPosition.row`
 * 比较会让 `///` 文档注释的行号邻接判定永远不成立，整个 crate 的 doc 全丢。
 * 其他语言的注释节点不含换行，这个归一化对它们是恒等的。
 */
function visualEndRow(node: TsNode): number {
  const { row, column } = node.endPosition;
  return column === 0 && row > node.startPosition.row ? row - 1 : row;
}

export function cleanComment(raw: string): string {
  return raw
    .split("\n")
    .map((line) =>
      line
        .replace(/^\s*\/\*\*?/, "")
        .replace(/\*\/\s*$/, "")
        .replace(/^\s*\*\s?/, "")
        .replace(/^\s*\/\/\/?\s?/, "")
        .replace(/^\s*#\s?/, "")
        .trimEnd(),
    )
    .join("\n")
    .trim();
}

/** Python docstring：函数体第一个语句是字符串字面量 */
export function pythonDocstring(bodyNode: TsNode | null): string | undefined {
  if (!bodyNode) return undefined;
  const first = bodyNode.namedChild(0);
  if (!first) return undefined;
  const expr = first.type === "expression_statement" ? first.namedChild(0) : first;
  if (!expr || expr.type !== "string") return undefined;
  return expr.text
    .replace(/^[rubfRUBF]*("""|'''|"|')/, "")
    .replace(/("""|'''|"|')$/, "")
    .trim()
    .slice(0, 1000);
}

// ---------------------------------------------------------------------------
// 复杂度
// ---------------------------------------------------------------------------

/**
 * 圈复杂度近似：分支节点计数 + 1。
 *
 * 不追求与任何工具的精确一致——这个数字的唯一用途是在目录树上做热力排序，
 * 让用户先看到最复杂的地方。相对大小正确就够了。
 */
export function complexityOf(node: TsNode, decisionTypes: ReadonlySet<string>): number {
  let count = 1;
  walk(node, (n) => {
    if (decisionTypes.has(n.type)) count++;
  });
  return count;
}

// ---------------------------------------------------------------------------
// 结构指纹
// ---------------------------------------------------------------------------

/**
 * 这些节点类型承载的是名字和字面量，也就是「改一改就不一样」的部分。
 * 算形状时把它们塌成一个占位符，改了名的复制粘贴才会指纹相同。
 */
const OPAQUE_NODES: ReadonlySet<string> = new Set([
  "identifier",
  "type_identifier",
  "field_identifier",
  "property_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "statement_identifier",
  "package_identifier",
  "label_name",
  "string",
  "string_literal",
  "raw_string_literal",
  "interpreted_string_literal",
  "template_string",
  "number",
  "integer",
  "integer_literal",
  "float",
  "float_literal",
  "char_literal",
  "true",
  "false",
  "none",
  "null",
  "nil",
  "undefined",
  "comment",
  "line_comment",
  "block_comment",
]);

/**
 * 符号的结构指纹：只保留 AST 的节点类型骨架。
 *
 * 存在的理由是 AI 写出来的代码有个特征病征——同一段逻辑按语言、按场景
 * 各生成一遍，而不是抽出共用。这种重复用名字匹配抓不准（同名的 `main`
 * 往往互不相干，改了名的复制粘贴又漏掉），用原文哈希也抓不住（换个变量名
 * 就不同）。只比形状正好落在中间：控制流一样就算同一份实现。
 *
 * 用括号记录层级，否则 `if{a;b}` 和 `if{a};b` 会塌成同一个串。
 */
export function attachShapes(root: TsNode, symbols: ParsedSymbol[]): void {
  for (const sym of symbols) {
    // 取恰好覆盖该符号字节区间的最小节点，也就是它的声明节点本身
    const node = root.descendantForIndex(sym.startByte, sym.endByte - 1);
    sym.shape = node ? shapeOf(node) : null;
  }
}

export function shapeOf(node: TsNode): string {
  const parts: string[] = [];
  const visit = (n: TsNode): void => {
    if (OPAQUE_NODES.has(n.type)) {
      parts.push("_");
      return;
    }
    parts.push(n.type, "(");
    for (let i = 0; i < n.namedChildCount; i++) {
      const child = n.namedChild(i);
      if (child) visit(child);
    }
    parts.push(")");
  };
  visit(node);
  return parts.join("");
}

export const TS_DECISIONS: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "for_in_statement",
  "while_statement",
  "do_statement",
  "switch_case",
  "catch_clause",
  "ternary_expression",
  // `&&` / `||` 也贡献分支，但它们是带 operator 字段的 binary_expression，
  // 整类计入会严重高估，这里放弃这部分精度。
]);

export const PY_DECISIONS: ReadonlySet<string> = new Set([
  "if_statement",
  "elif_clause",
  "for_statement",
  "while_statement",
  "except_clause",
  "conditional_expression",
  "match_statement",
  "case_clause",
  "boolean_operator",
  "assert_statement",
]);

export const GO_DECISIONS: ReadonlySet<string> = new Set([
  "if_statement",
  "for_statement",
  "expression_switch_statement",
  "type_switch_statement",
  "expression_case",
  "type_case",
  "select_statement",
  "communication_case",
]);

export const RUST_DECISIONS: ReadonlySet<string> = new Set([
  "if_expression",
  "if_let_expression",
  "while_expression",
  "while_let_expression",
  "for_expression",
  "loop_expression",
  "match_arm",
  "try_expression",
]);

// ---------------------------------------------------------------------------
// 调用点归属
// ---------------------------------------------------------------------------

export interface RawCallSite {
  callee: string;
  receiver?: string | undefined;
  calleePath?: string[] | undefined;
  line: number;
  argCount: number;
  argumentTexts?: string[] | undefined;
  kind: CallKind;
  /** 调用点在文件中的字节偏移，用于定位所属符号 */
  byte: number;
}

/**
 * 把调用点归属到包含它的最内层符号。
 *
 * 抽取器只负责找到调用点，归属统一在这里做：这样每种语言都不必重复实现
 * 「我现在在哪个函数里」的状态跟踪，也避免了嵌套闭包导致的归属错误。
 */
export function attributeCalls(symbols: readonly ParsedSymbol[], sites: readonly RawCallSite[]): ParsedCall[] {
  const callable = symbols
    .filter((s) => s.kind === "function" || s.kind === "method")
    .slice()
    // 按区间长度升序，第一个命中的就是最内层
    .sort((a, b) => a.endByte - a.startByte - (b.endByte - b.startByte));

  return sites.map((site) => {
    const owner = callable.find((s) => site.byte >= s.startByte && site.byte < s.endByte);
    return {
      callerName: owner?.name ?? null,
      callerContainer: owner?.container,
      callee: site.callee,
      receiver: site.receiver,
      calleePath: site.calleePath,
      line: site.line,
      argCount: site.argCount,
      argumentTexts: site.argumentTexts,
      kind: site.kind,
    };
  });
}

/** 把 `a.b.c` 形式的成员表达式拆成路径段 */
export function dottedPath(text: string): string[] {
  return normalizeWhitespace(text)
    .split(".")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && /^[A-Za-z_$][\w$]*$/.test(s));
}
