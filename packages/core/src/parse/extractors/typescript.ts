import type {
  ImportKind,
  ParsedExport,
  ParsedFile,
  ParsedImport,
  ParsedImportSpecifier,
  ParsedParam,
  ParsedSymbol,
  ParsedTypeRelation,
  SymbolKind,
} from "../../types.js";
import {
  ancestorOfType,
  attributeCalls,
  complexityOf,
  docCommentAbove,
  dottedPath,
  fieldNode,
  fieldText,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  signatureOf,
  TS_DECISIONS,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

const COMMENT_TYPES = ["comment"] as const;

const FUNCTION_NODES = new Set([
  "function_declaration",
  "generator_function_declaration",
  "function_signature",
]);

/**
 * TypeScript / JavaScript / TSX 抽取器。
 *
 * 四种语言共用一套逻辑：tsx 语法是 typescript 语法的超集，JS 只是少用类型节点，
 * 按语言分叉只会产生四份几乎相同的代码。
 */
export const typescriptExtractor: LanguageExtractor = {
  family: "ts",
  extract(input: ExtractInput): ParsedFile {
    const { root } = input;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const exports: ParsedExport[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const callSites: RawCallSite[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "import_statement":
          collectImport(node, imports);
          return false;

        case "export_statement":
          collectExport(node, exports, imports);
          return true; // 继续深入：declaration 里的符号还要抽取

        case "function_declaration":
        case "generator_function_declaration":
        case "function_signature":
          symbols.push(functionSymbol(node, undefined));
          return true;

        case "method_definition":
        case "method_signature":
        case "abstract_method_signature": {
          const container = enclosingTypeName(node);
          symbols.push(functionSymbol(node, container, "method"));
          return true;
        }

        case "class_declaration":
        case "abstract_class_declaration":
          symbols.push(typeSymbol(node, "class"));
          collectHeritage(node, typeRelations);
          return true;

        case "interface_declaration":
          symbols.push(typeSymbol(node, "interface"));
          collectHeritage(node, typeRelations);
          return true;

        case "type_alias_declaration":
          symbols.push(typeSymbol(node, "type"));
          return true;

        case "enum_declaration":
          symbols.push(typeSymbol(node, "enum"));
          return true;

        case "variable_declarator": {
          const sym = variableSymbol(node);
          if (sym) symbols.push(sym);
          return true;
        }

        case "call_expression":
          collectCall(node, callSites, imports);
          return true;

        case "new_expression": {
          const ctor = fieldNode(node, "constructor");
          if (ctor) {
            const path = dottedPath(ctor.text);
            const name = path.at(-1);
            if (name) {
              callSites.push({
                callee: name,
                receiver: path.length > 1 ? path.slice(0, -1).join(".") : undefined,
                calleePath: path.length > 1 ? path : undefined,
                line: lineOf(node),
                argCount: countArgs(fieldNode(node, "arguments")),
                kind: "new",
                byte: node.startIndex,
              });
            }
          }
          return true;
        }

        default:
          return true;
      }
    });

    return {
      symbols,
      imports,
      exports,
      calls: attributeCalls(symbols, callSites),
      typeRelations,
      hasError: root.hasError,
    };
  },
};

// ---------------------------------------------------------------------------
// 符号
// ---------------------------------------------------------------------------

function functionSymbol(
  node: TsNode,
  container: string | undefined,
  kindOverride?: SymbolKind,
): ParsedSymbol {
  const nameNode = fieldNode(node, "name");
  const name = nameNode?.text ?? "<anonymous>";
  const params = extractParams(fieldNode(node, "parameters"));
  const returnType = typeAnnotationText(fieldNode(node, "return_type"));

  return {
    name,
    kind: kindOverride ?? "function",
    container,
    exported: isExported(node),
    signature: signatureOf(node),
    params,
    returnType,
    doc: docCommentAbove(exportWrapper(node), COMMENT_TYPES),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, TS_DECISIONS),
    isAsync: /(^|\s)async(\s|$)/.test(prefixBeforeName(node)),
    isStatic: hasModifier(node, "static"),
  };
}

function typeSymbol(node: TsNode, kind: SymbolKind): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  return {
    name,
    kind,
    exported: isExported(node),
    signature: signatureOf(node, ["body"]),
    doc: docCommentAbove(exportWrapper(node), COMMENT_TYPES),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: 1,
  };
}

/**
 * `const foo = () => {}` 这种形式在 TS 代码里极常见，必须当成函数符号处理，
 * 否则整个代码库里的箭头函数都会从图上消失。
 */
function variableSymbol(node: TsNode): ParsedSymbol | null {
  const nameNode = fieldNode(node, "name");
  if (!nameNode || nameNode.type !== "identifier") return null;
  const value = fieldNode(node, "value");

  const isFunctionValue =
    value !== null &&
    (value.type === "arrow_function" ||
      value.type === "function_expression" ||
      value.type === "function" ||
      value.type === "generator_function");

  const declaration = ancestorOfType(node, ["lexical_declaration", "variable_declaration"]);
  const isConst = declaration?.text.startsWith("const") ?? false;

  if (!isFunctionValue) {
    // 只收顶层常量：函数体内的局部变量不属于「架构」信息，收进来纯是噪音
    const isTopLevel = declaration ? isTopLevelStatement(declaration) : false;
    if (!isTopLevel || !isConst) return null;
    return {
      name: nameNode.text,
      kind: "constant",
      exported: isExported(node),
      signature: normalizeWhitespace(node.text).slice(0, 200),
      doc: docCommentAbove(exportWrapper(declaration ?? node), COMMENT_TYPES),
      startLine: lineOf(node),
      endLine: node.endPosition.row + 1,
      startByte: node.startIndex,
      endByte: node.endIndex,
      complexity: 1,
    };
  }

  const fn = value as TsNode;
  return {
    name: nameNode.text,
    kind: "function",
    exported: isExported(node),
    signature: `${nameNode.text}${signatureOf(fn)}`,
    params: extractParams(fieldNode(fn, "parameters") ?? fieldNode(fn, "parameter")),
    returnType: typeAnnotationText(fieldNode(fn, "return_type")),
    doc: docCommentAbove(exportWrapper(declaration ?? node), COMMENT_TYPES),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(fn, TS_DECISIONS),
    isAsync: fn.text.startsWith("async"),
  };
}

function isTopLevelStatement(node: TsNode): boolean {
  const parent = node.parent;
  if (!parent) return false;
  return parent.type === "program" || parent.type === "export_statement";
}

function extractParams(paramsNode: TsNode | null): ParsedParam[] | undefined {
  if (!paramsNode) return undefined;

  // 单参数箭头函数 `x => x` 没有 formal_parameters 包裹
  if (paramsNode.type === "identifier") {
    return [{ name: paramsNode.text, optional: false, variadic: false }];
  }

  const out: ParsedParam[] = [];
  for (const child of namedChildren(paramsNode)) {
    switch (child.type) {
      case "required_parameter":
      case "optional_parameter": {
        const pattern = fieldNode(child, "pattern");
        out.push({
          name: pattern ? normalizeWhitespace(pattern.text) : "_",
          type: typeAnnotationText(fieldNode(child, "type")),
          defaultValue: fieldNode(child, "value")?.text,
          optional: child.type === "optional_parameter" || child.text.includes("?:"),
          variadic: pattern?.type === "rest_pattern",
        });
        break;
      }
      case "identifier":
        out.push({ name: child.text, optional: false, variadic: false });
        break;
      case "rest_pattern":
        out.push({ name: normalizeWhitespace(child.text), optional: false, variadic: true });
        break;
      case "object_pattern":
      case "array_pattern":
        out.push({ name: normalizeWhitespace(child.text).slice(0, 120), optional: false, variadic: false });
        break;
      case "assignment_pattern":
        out.push({
          name: normalizeWhitespace(fieldNode(child, "left")?.text ?? "_"),
          defaultValue: fieldNode(child, "right")?.text,
          optional: true,
          variadic: false,
        });
        break;
      default:
        break;
    }
  }
  return out;
}

function typeAnnotationText(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const text = normalizeWhitespace(node.text).replace(/^:\s*/, "");
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

function prefixBeforeName(node: TsNode): string {
  const nameNode = fieldNode(node, "name");
  if (!nameNode) return node.text.slice(0, 40);
  return node.text.slice(0, nameNode.startIndex - node.startIndex);
}

function hasModifier(node: TsNode, modifier: string): boolean {
  for (let i = 0; i < node.childCount; i++) {
    const child = node.child(i);
    if (child && !child.isNamed && child.text === modifier) return true;
  }
  return false;
}

function enclosingTypeName(node: TsNode): string | undefined {
  const owner = ancestorOfType(node, [
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "class",
  ]);
  return owner ? (fieldText(owner, "name") ?? undefined) : undefined;
}

/** 声明被 `export` 包裹时，文档注释挂在 export_statement 上而不是声明上 */
function exportWrapper(node: TsNode): TsNode {
  const parent = node.parent;
  return parent?.type === "export_statement" ? parent : node;
}

function isExported(node: TsNode): boolean {
  return ancestorOfType(node, ["export_statement"]) !== null;
}

// ---------------------------------------------------------------------------
// import / export
// ---------------------------------------------------------------------------

function collectImport(node: TsNode, out: ParsedImport[]): void {
  const source = stringLiteral(fieldNode(node, "source"));
  if (source === null) return;

  const specifiers: ParsedImportSpecifier[] = [];
  const clause = firstChildOfTypes(node, ["import_clause"]);

  if (clause) {
    for (const child of namedChildren(clause)) {
      switch (child.type) {
        case "identifier":
          specifiers.push({ imported: "default", local: child.text, isDefault: true });
          break;
        case "namespace_import": {
          const alias = namedChildren(child).at(-1);
          specifiers.push({ imported: "*", local: alias?.text ?? "*", isNamespace: true });
          break;
        }
        case "named_imports":
          for (const spec of namedChildren(child)) {
            if (spec.type !== "import_specifier") continue;
            const imported = fieldText(spec, "name") ?? spec.text;
            const alias = fieldText(spec, "alias");
            specifiers.push({ imported, local: alias ?? imported });
          }
          break;
        default:
          break;
      }
    }
  }

  out.push({
    source,
    kind: specifiers.length === 0 ? "side-effect" : "static",
    specifiers,
    line: lineOf(node),
    isTypeOnly: /^import\s+type\b/.test(node.text),
  });
}

function collectExport(node: TsNode, exports: ParsedExport[], imports: ParsedImport[]): void {
  const line = lineOf(node);
  const source = stringLiteral(fieldNode(node, "source"));

  // `export * from "./x"` / `export { a } from "./x"` 既是导出也是导入
  if (source !== null) {
    const clause = firstChildOfTypes(node, ["export_clause"]);
    if (clause) {
      const specifiers: ParsedImportSpecifier[] = [];
      for (const spec of namedChildren(clause)) {
        if (spec.type !== "export_specifier") continue;
        const name = fieldText(spec, "name") ?? spec.text;
        const alias = fieldText(spec, "alias");
        specifiers.push({ imported: name, local: alias ?? name });
        exports.push({ name: alias ?? name, kind: "named", source, line });
      }
      imports.push({ source, kind: "re-export", specifiers, line });
    } else {
      const alias = namedChildren(node).find((c) => c.type === "identifier" || c.type === "namespace_export");
      exports.push({ name: alias?.text ?? "*", kind: alias ? "star-as" : "star", source, line });
      imports.push({
        source,
        kind: "re-export",
        specifiers: [{ imported: "*", local: alias?.text ?? "*", isNamespace: true }],
        line,
      });
    }
    return;
  }

  if (node.text.startsWith("export default")) {
    exports.push({ name: "default", kind: "default", line });
    return;
  }

  const declaration = fieldNode(node, "declaration");
  if (declaration) {
    for (const name of declaredNames(declaration)) {
      exports.push({ name, kind: "named", line });
    }
    return;
  }

  const clause = firstChildOfTypes(node, ["export_clause"]);
  if (clause) {
    for (const spec of namedChildren(clause)) {
      if (spec.type !== "export_specifier") continue;
      const name = fieldText(spec, "name") ?? spec.text;
      exports.push({ name: fieldText(spec, "alias") ?? name, kind: "named", line });
    }
  }
}

function declaredNames(declaration: TsNode): string[] {
  const direct = fieldText(declaration, "name");
  if (direct !== null) return [direct];

  // `export const a = 1, b = 2`
  const out: string[] = [];
  for (const declarator of namedChildren(declaration)) {
    if (declarator.type !== "variable_declarator") continue;
    const name = fieldNode(declarator, "name");
    if (name?.type === "identifier") out.push(name.text);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

function collectCall(node: TsNode, out: RawCallSite[], imports: ParsedImport[]): void {
  const fn = fieldNode(node, "function");
  if (!fn) return;

  // require("x") 与 import("x") 是隐藏的模块依赖，不识别会漏掉整个 CJS 生态
  if (fn.type === "identifier" && fn.text === "require") {
    const source = stringLiteral(firstArg(node));
    if (source !== null) {
      imports.push({ source, kind: "require", specifiers: [], line: lineOf(node) });
      return;
    }
  }
  if (fn.type === "import") {
    const source = stringLiteral(firstArg(node));
    if (source !== null) {
      imports.push({ source, kind: "dynamic", specifiers: [], line: lineOf(node) });
      return;
    }
  }

  const argCount = countArgs(fieldNode(node, "arguments"));

  if (fn.type === "identifier") {
    out.push({
      callee: fn.text,
      line: lineOf(node),
      argCount,
      kind: "call",
      byte: node.startIndex,
    });
    return;
  }

  if (fn.type === "member_expression" || fn.type === "subscript_expression") {
    const property = fieldText(fn, "property");
    if (property === null) return;
    const objectNode = fieldNode(fn, "object");
    const receiver = objectNode ? normalizeWhitespace(objectNode.text).slice(0, 120) : undefined;
    const path = dottedPath(fn.text);
    out.push({
      callee: property,
      receiver,
      calleePath: path.length > 1 ? path : undefined,
      line: lineOf(node),
      argCount,
      kind: "method",
      byte: node.startIndex,
    });
  }
}

function firstArg(callNode: TsNode): TsNode | null {
  const args = fieldNode(callNode, "arguments");
  if (!args) return null;
  return args.namedChild(0) ?? null;
}

function countArgs(argsNode: TsNode | null): number {
  if (!argsNode) return 0;
  return namedChildren(argsNode).filter((c) => c.type !== "comment").length;
}

// ---------------------------------------------------------------------------
// 类型关系
// ---------------------------------------------------------------------------

function collectHeritage(node: TsNode, out: ParsedTypeRelation[]): void {
  const subject = fieldText(node, "name");
  if (subject === null) return;
  const subjectKind: SymbolKind = node.type === "interface_declaration" ? "interface" : "class";

  walk(node, (child) => {
    if (child === node) return true;
    // 只看直接的继承子句，不深入类体
    if (child.type === "class_body" || child.type === "interface_body" || child.type === "object_type") {
      return false;
    }
    if (child.type === "extends_clause" || child.type === "extends_type_clause") {
      for (const target of heritageTargets(child)) {
        out.push({ subject, subjectKind, relation: "extends", target, line: lineOf(child) });
      }
      return false;
    }
    if (child.type === "implements_clause") {
      for (const target of heritageTargets(child)) {
        out.push({ subject, subjectKind, relation: "implements", target, line: lineOf(child) });
      }
      return false;
    }
    return true;
  });
}

function heritageTargets(clause: TsNode): string[] {
  const out: string[] = [];
  for (const child of namedChildren(clause)) {
    if (child.type === "type_parameters" || child.type === "type_arguments") continue;
    const path = dottedPath(child.text.replace(/<.*$/s, ""));
    const name = path.at(-1);
    if (name) out.push(name);
  }
  return out;
}

// ---------------------------------------------------------------------------
// 通用小工具
// ---------------------------------------------------------------------------

function firstChildOfTypes(node: TsNode, types: string[]): TsNode | null {
  for (const child of namedChildren(node)) {
    if (types.includes(child.type)) return child;
  }
  return null;
}

function stringLiteral(node: TsNode | null): string | null {
  if (!node) return null;
  if (node.type !== "string" && node.type !== "template_string") return null;
  const text = node.text;
  // 带插值的模板字符串是动态路径，解析不了就别装作能解析
  if (text.includes("${")) return null;
  return text.slice(1, -1);
}
