import type {
  ParsedExport,
  ParsedFile,
  ParsedImport,
  ParsedParam,
  ParsedSymbol,
  ParsedTypeRelation,
  SymbolKind,
} from "../../types.js";
import {
  attributeCalls,
  childrenOfType,
  complexityOf,
  docCommentAbove,
  dottedPath,
  fieldNode,
  fieldText,
  firstOfType,
  GO_DECISIONS,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  signatureOf,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

const COMMENT_TYPES = ["comment"] as const;

/** 文档注释可能挂在 spec 自己身上，也可能挂在包裹它的声明上 */
const SPEC_WRAPPERS = new Set([
  "type_declaration",
  "const_declaration",
  "var_declaration",
  "var_spec_list",
  "const_spec_list",
]);

/**
 * Go 抽取器。
 *
 * Go 的可见性完全由首字母大小写决定，没有 export 语句，所以 `exports` 直接由
 * 导出符号推导而来，不需要单独的语法分支。
 */
export const goExtractor: LanguageExtractor = {
  family: "go",
  extract(input: ExtractInput): ParsedFile {
    const { root } = input;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const callSites: RawCallSite[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "import_declaration":
          collectImports(node, imports);
          return false;

        case "function_declaration":
          symbols.push(functionSymbol(node));
          return true;

        case "method_declaration":
          symbols.push(methodSymbol(node));
          return true;

        case "type_declaration":
          collectTypes(node, symbols, typeRelations);
          return true;

        case "const_declaration":
          collectValues(node, symbols, "constant");
          return true;

        case "var_declaration":
          collectValues(node, symbols, "variable");
          return true;

        case "call_expression":
          collectCall(node, callSites);
          return true;

        default:
          return true;
      }
    });

    return {
      symbols,
      imports,
      exports: symbols
        .filter((s) => s.exported && s.container === undefined)
        .map((s): ParsedExport => ({ name: s.name, kind: "named", line: s.startLine })),
      calls: attributeCalls(symbols, callSites),
      typeRelations,
      hasError: root.hasError,
    };
  },
};

// ---------------------------------------------------------------------------
// 函数与方法
// ---------------------------------------------------------------------------

function functionSymbol(node: TsNode): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  return {
    name,
    kind: "function",
    exported: isExported(name),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "result")),
    doc: docCommentAbove(node, COMMENT_TYPES),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, GO_DECISIONS),
  };
}

function methodSymbol(node: TsNode): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  const receiverType = receiverTypeOf(node);
  return {
    name,
    kind: "method",
    container: receiverType === undefined ? undefined : baseTypeName(receiverType),
    exported: isExported(name),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "result")),
    doc: docCommentAbove(node, COMMENT_TYPES),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, GO_DECISIONS),
    receiverType,
  };
}

function receiverTypeOf(node: TsNode): string | undefined {
  const receiver = fieldNode(node, "receiver");
  if (!receiver) return undefined;
  const declaration = firstOfType(receiver, "parameter_declaration");
  if (!declaration) return undefined;
  const type = fieldNode(declaration, "type");
  return type ? normalizeWhitespace(type.text) : undefined;
}

/** `*Server` / `Server[T]` → `Server`：container 要和 type 声明的名字对得上 */
function baseTypeName(text: string): string {
  return text.replace(/^[*&\s]+/, "").replace(/\[.*$/s, "").trim();
}

function isExported(name: string): boolean {
  return /^[A-Z]/.test(name);
}

// ---------------------------------------------------------------------------
// 类型 / 常量 / 变量声明
// ---------------------------------------------------------------------------

function collectTypes(
  declaration: TsNode,
  symbols: ParsedSymbol[],
  relations: ParsedTypeRelation[],
): void {
  for (const spec of namedChildren(declaration)) {
    if (spec.type !== "type_spec" && spec.type !== "type_alias") continue;
    const name = fieldText(spec, "name");
    if (name === null) continue;

    const typeNode = fieldNode(spec, "type");
    const kind = spec.type === "type_alias" ? "type" : typeKindOf(typeNode);

    symbols.push({
      name,
      kind,
      exported: isExported(name),
      // type_spec 没有 body 字段，signatureOf 会退回整段原文——对结构体而言
      // 把字段列表一起展示反而更有用，超长部分由 signatureOf 自己截断
      signature: signatureOf(spec, ["body"]),
      doc: docOf(spec),
      startLine: lineOf(spec),
      endLine: spec.endPosition.row + 1,
      startByte: spec.startIndex,
      endByte: spec.endIndex,
      complexity: 1,
    });

    if (typeNode) collectEmbeds(name, typeNode, relations);
  }
}

function typeKindOf(typeNode: TsNode | null): SymbolKind {
  if (!typeNode) return "type";
  if (typeNode.type === "struct_type") return "struct";
  if (typeNode.type === "interface_type") return "interface";
  return "type";
}

/** 只收顶层 const / var：函数体里的局部声明不是架构信息 */
function collectValues(declaration: TsNode, symbols: ParsedSymbol[], kind: SymbolKind): void {
  if (declaration.parent?.type !== "source_file") return;

  for (const spec of specsOf(declaration)) {
    for (const nameNode of fieldNodes(spec, "name")) {
      const name = nameNode.text;
      symbols.push({
        name,
        kind,
        exported: isExported(name),
        signature: normalizeWhitespace(spec.text).slice(0, 200),
        doc: docOf(spec),
        startLine: lineOf(spec),
        endLine: spec.endPosition.row + 1,
        startByte: spec.startIndex,
        endByte: spec.endIndex,
        complexity: 1,
      });
    }
  }
}

/** `const A = 1` 的 spec 是声明的直接子节点，`const ( ... )` 里可能多一层 spec_list */
function specsOf(declaration: TsNode): TsNode[] {
  const out: TsNode[] = [];
  for (const child of namedChildren(declaration)) {
    if (child.type === "const_spec" || child.type === "var_spec") out.push(child);
    else if (child.type === "const_spec_list" || child.type === "var_spec_list") {
      out.push(...namedChildren(child).filter((c) => c.type === "const_spec" || c.type === "var_spec"));
    }
  }
  return out;
}

function docOf(spec: TsNode): string | undefined {
  const own = docCommentAbove(spec, COMMENT_TYPES);
  if (own !== undefined) return own;

  // `// Doc` + `type X struct{}` 的注释是 type_declaration 的兄弟，不是 type_spec 的
  let cursor: TsNode | null = spec.parent;
  while (cursor && SPEC_WRAPPERS.has(cursor.type)) {
    const inherited = docCommentAbove(cursor, COMMENT_TYPES);
    if (inherited !== undefined) return inherited;
    cursor = cursor.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function extractParams(paramsNode: TsNode | null): ParsedParam[] | undefined {
  if (!paramsNode) return undefined;

  const out: ParsedParam[] = [];
  for (const declaration of namedChildren(paramsNode)) {
    const variadic = declaration.type === "variadic_parameter_declaration";
    if (!variadic && declaration.type !== "parameter_declaration") continue;

    const type = annotationText(fieldNode(declaration, "type"));
    const names = fieldNodes(declaration, "name");

    // `func f(int, error)` 这种只有类型没有名字的声明（多见于返回值列表）
    if (names.length === 0) {
      out.push({ name: "_", type, optional: false, variadic });
      continue;
    }
    // `a, b int` 是一个声明里的两个参数，必须展开
    for (const nameNode of names) {
      out.push({ name: nameNode.text, type, optional: false, variadic });
    }
  }
  return out;
}

function annotationText(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const text = normalizeWhitespace(node.text);
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

/**
 * 取同名字段的全部取值。
 *
 * tree-sitter 会把 `a, b int` 里的逗号也标成 `name` 字段，所以必须过掉匿名节点。
 */
function fieldNodes(node: TsNode, field: string): TsNode[] {
  const out: TsNode[] = [];
  for (let i = 0; i < node.childCount; i++) {
    if (node.fieldNameForChild(i) !== field) continue;
    const child = node.child(i);
    if (child?.isNamed) out.push(child);
  }
  return out;
}

// ---------------------------------------------------------------------------
// import
// ---------------------------------------------------------------------------

function collectImports(declaration: TsNode, out: ParsedImport[]): void {
  walk(declaration, (node) => {
    if (node.type !== "import_spec") return true;

    const source = unquote(fieldNode(node, "path"));
    if (source === null) return false;

    const alias = fieldNode(node, "name")?.text;
    out.push({
      source,
      // `import _ "driver"` 只为触发 init()，没有任何符号级依赖
      kind: alias === "_" ? "side-effect" : "static",
      specifiers: [{ imported: "*", local: alias ?? lastSegment(source), isNamespace: true }],
      line: lineOf(node),
    });
    return false;
  });
}

function unquote(node: TsNode | null): string | null {
  if (!node) return null;
  const text = node.text;
  if (text.length < 2) return null;
  const quote = text[0];
  if (quote !== '"' && quote !== "`") return null;
  return text.slice(1, -1);
}

function lastSegment(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? path : path.slice(slash + 1);
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

function collectCall(node: TsNode, out: RawCallSite[]): void {
  // `f[int](x)` 会被语法解析成 type_conversion_expression 而不是 call_expression，
  // 泛型函数调用在 Go 里天然抓不到；`handlers[i](x)` 也一样，不去猜。
  const target = fieldNode(node, "function");
  if (!target) return;

  const argCount = countArgs(fieldNode(node, "arguments"));
  const line = lineOf(node);
  const byte = node.startIndex;

  if (target.type === "identifier") {
    out.push({ callee: target.text, line, argCount, kind: "call", byte });
    return;
  }

  if (target.type === "selector_expression") {
    const callee = fieldText(target, "field");
    if (callee === null) return;
    const operand = fieldNode(target, "operand");
    const path = dottedPath(target.text);
    // `pkg.Func()` 与 `obj.Method()` 在语法上同形，抽取阶段无法区分，
    // 如实记下 receiver，消歧交给 link 阶段（那时才有 import 表和符号表）
    out.push({
      callee,
      receiver: operand ? normalizeWhitespace(operand.text).slice(0, 120) : undefined,
      calleePath: path.length > 1 ? path : undefined,
      line,
      argCount,
      kind: "method",
      byte,
    });
  }
}

function countArgs(argsNode: TsNode | null): number {
  if (!argsNode) return 0;
  return namedChildren(argsNode).filter((c) => c.type !== "comment").length;
}

// ---------------------------------------------------------------------------
// 嵌入关系
// ---------------------------------------------------------------------------

function collectEmbeds(subject: string, typeNode: TsNode, out: ParsedTypeRelation[]): void {
  if (typeNode.type === "struct_type") {
    const fields = firstOfType(typeNode, "field_declaration_list");
    if (!fields) return;
    for (const field of childrenOfType(fields, "field_declaration")) {
      // 匿名字段就是嵌入：只有 type 没有 name
      if (fieldNodes(field, "name").length > 0) continue;
      pushEmbed(subject, "struct", fieldNode(field, "type"), field, out);
    }
    return;
  }

  if (typeNode.type === "interface_type") {
    for (const elem of childrenOfType(typeNode, "type_elem")) {
      const parts = namedChildren(elem);
      // 类型集约束（`int | ~string`）不是接口嵌入，只接受单一具名类型
      if (parts.length !== 1) continue;
      pushEmbed(subject, "interface", parts[0] ?? null, elem, out);
    }
  }
}

const EMBEDDABLE_TYPES = new Set(["type_identifier", "qualified_type", "generic_type"]);

function pushEmbed(
  subject: string,
  subjectKind: SymbolKind,
  typeNode: TsNode | null,
  lineNode: TsNode,
  out: ParsedTypeRelation[],
): void {
  if (!typeNode || !EMBEDDABLE_TYPES.has(typeNode.type)) return;
  const path = dottedPath(typeNode.text.replace(/^[*&\s]+/, "").replace(/\[.*$/s, ""));
  const target = path.at(-1);
  if (target === undefined) return;

  out.push({
    subject,
    subjectKind,
    relation: "embeds",
    target,
    targetPath: path.length > 1 ? path : undefined,
    line: lineOf(lineNode),
  });
}
