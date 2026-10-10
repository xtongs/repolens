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
  argumentTexts,
  attributeCalls,
  calleeAt,
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
          const container = enclosingTypeName(node) ?? objectOwnerName(node) ?? undefined;
          symbols.push(functionSymbol(node, container, "method"));
          return true;
        }

        case "pair": {
          const sym = objectMethodSymbol(node);
          if (sym) symbols.push(sym);
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

        case "call_expression": {
          collectCall(node, callSites, imports);
          const handler = inlineHandlerSymbol(node, symbols);
          if (handler) symbols.push(handler);
          return true;
        }

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
                argumentTexts: argumentTexts(fieldNode(node, "arguments")),
                kind: "new",
                byte: node.startIndex,
                endByte: node.endIndex,
                ...calleeAt(ctor, name),
              });
            }
          }
          return true;
        }

        case "jsx_opening_element":
        case "jsx_self_closing_element":
          collectJsxElement(node, callSites);
          return true;

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
    exported: kindOverride === "method" ? isExported(node) : isDirectlyExported(node),
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
    exported: isDirectlyExported(node),
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

  const declaration = ancestorOfType(node, ["lexical_declaration", "variable_declaration"]);
  const isConst = declaration?.text.startsWith("const") ?? false;
  const isTopLevel = declaration ? isTopLevelStatement(declaration) : false;
  const wrapped = isTopLevel && value?.type === "call_expression" ? wrappedFunction(value) : null;

  const isFunctionValue =
    wrapped !== null ||
    (value !== null &&
      (value.type === "arrow_function" ||
        value.type === "function_expression" ||
        value.type === "function" ||
        value.type === "generator_function"));

  if (!isFunctionValue) {
    // 只收顶层常量：函数体内的局部变量不属于「架构」信息，收进来纯是噪音
    if (!isTopLevel || !isConst) return null;
    return {
      name: nameNode.text,
      kind: "constant",
      exported: isDirectlyExported(node),
      signature: normalizeWhitespace(node.text).slice(0, 200),
      doc: docCommentAbove(exportWrapper(declaration ?? node), COMMENT_TYPES),
      startLine: lineOf(node),
      endLine: node.endPosition.row + 1,
      startByte: node.startIndex,
      endByte: node.endIndex,
      complexity: 1,
    };
  }

  const fn = wrapped ?? (value as TsNode);
  return {
    name: nameNode.text,
    kind: "function",
    exported: isDirectlyExported(node),
    signature: wrapped
      ? `${nameNode.text} = ${normalizeWhitespace(fieldNode(value as TsNode, "function")?.text ?? "")}(${signatureOf(fn)} …)`.slice(0, 400)
      : `${nameNode.text}${signatureOf(fn)}`,
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

/** 回调产出的是数据而不是函数：`const rows = list.map((x) => …)` 不是函数定义 */
const DATA_CALLBACK_METHODS = new Set([
  "map", "filter", "reduce", "reduceRight", "flatMap", "forEach", "find", "findIndex", "findLast",
  "some", "every", "sort", "toSorted", "from", "fromEntries", "then", "catch", "finally", "replace", "replaceAll",
]);
const DATA_RECEIVERS = new Set(["Object", "Array", "Promise", "JSON", "Math"]);
const OBJECT_WRAPPERS = new Set(["as_expression", "satisfies_expression", "parenthesized_expression"]);

/**
 * `memo(function Card() {…})`、`forwardRef((props, ref) => …)`、`create((set) => ({…}))`：
 * 顶层常量的值是包了一层的函数。不当函数的话，组件或 store 的整段函数体没有归属，
 * 里面的调用和渲染关系全挂在文件头上，别处对它的调用也连不上。
 */
function wrappedFunction(call: TsNode): TsNode | null {
  const path = dottedPath(fieldNode(call, "function")?.text ?? "");
  if (DATA_CALLBACK_METHODS.has(path.at(-1) ?? "") || DATA_RECEIVERS.has(path[0] ?? "")) return null;
  const args = namedChildren(fieldNode(call, "arguments") ?? call).filter((c) => c.type !== "comment");
  return args.find((arg) => INLINE_FUNCTIONS.has(arg.type)) ?? null;
}

/**
 * 顶层常量对象的直接成员归到常量名下：`export const api = { load: () => get("/x") }`
 * 里的 load 记成 `api.load`。API 客户端、命令表、处理器映射常写成这样，
 * 不收的话这些函数体里的调用全都没有归属。更深的嵌套对象多是配置，不收。
 */
function objectOwnerName(member: TsNode): string | null {
  let cursor = member.parent;
  if (cursor?.type !== "object") return null;
  while (cursor.parent && OBJECT_WRAPPERS.has(cursor.parent.type)) cursor = cursor.parent;
  const declarator = cursor.parent;
  if (declarator?.type !== "variable_declarator") return null;
  const declaration = ancestorOfType(declarator, ["lexical_declaration", "variable_declaration"]);
  if (!declaration || !isTopLevelStatement(declaration) || !declaration.text.startsWith("const")) return null;
  const name = fieldNode(declarator, "name");
  return name?.type === "identifier" ? name.text : null;
}

function objectMethodSymbol(pair: TsNode): ParsedSymbol | null {
  const value = fieldNode(pair, "value");
  if (!value || !INLINE_FUNCTIONS.has(value.type) || isModuleLoader(value)) return null;
  const container = objectOwnerName(pair);
  if (container === null) return null;
  const key = fieldNode(pair, "key");
  // 字符串键只收像名字的（`"repo:pick"`、`"/users"`）；翻译表、文案映射的键是句子，不是函数名
  const name = key?.type === "property_identifier" ? key.text : stringLiteral(key);
  if (!name || !/^[\w$.:/@-]+$/.test(name)) return null;
  return {
    name,
    kind: "method",
    container,
    exported: isExported(pair),
    signature: `${name}: ${signatureOf(value)}`.slice(0, 400),
    params: extractParams(fieldNode(value, "parameters") ?? fieldNode(value, "parameter")),
    returnType: typeAnnotationText(fieldNode(value, "return_type")),
    doc: docCommentAbove(pair, COMMENT_TYPES),
    startLine: lineOf(pair),
    endLine: pair.endPosition.row + 1,
    startByte: pair.startIndex,
    endByte: pair.endIndex,
    complexity: complexityOf(value, TS_DECISIONS),
    isAsync: value.text.startsWith("async"),
  };
}

/** `() => import("./x")`：懒加载表里的一项引用的是模块，不是一段逻辑 */
function isModuleLoader(fn: TsNode): boolean {
  const body = fieldNode(fn, "body");
  return body?.type === "call_expression" && fieldNode(body, "function")?.type === "import";
}

const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const EVENT_METHODS = new Set(["on", "once", "handle", "handleOnce", "addEventListener", "addListener", "subscribe"]);
const INLINE_FUNCTIONS = new Set(["arrow_function", "function_expression", "function", "generator_function"]);

/**
 * 注册调用里的内联回调：`app.get("/x", (c) => …)`、`program.command("scan").action(async () => …)`、
 * `ipcMain.handle("pick", async () => …)`。它们是真正的业务入口，却没有名字——不单独成符号的话，
 * 里面的调用全都记在外层 `createApi` 头上，路由入口也走读不进去。
 *
 * 名字按注册语义合成（`GET /x`、`CLI scan`、`ipcMain.handle("pick")`），入口识别按同样的规则找回它。
 */
function inlineHandlerSymbol(call: TsNode, existing: readonly ParsedSymbol[]): ParsedSymbol | null {
  const fn = fieldNode(call, "function");
  if (fn?.type !== "member_expression") return null;
  const args = namedChildren(fieldNode(call, "arguments") ?? call).filter((c) => c.type !== "comment");
  const handler = args.at(-1);
  if (!handler || !INLINE_FUNCTIONS.has(handler.type)) return null;

  const method = fieldText(fn, "property") ?? "";
  const object = fieldNode(fn, "object");
  const literal = args.length > 1 ? stringLiteral(args[0] ?? null) : null;
  let name: string | null = null;
  if (HTTP_VERBS.has(method.toLowerCase()) && literal?.startsWith("/")) {
    name = `${method.toLowerCase() === "all" ? "HTTP" : method.toUpperCase()} ${literal}`;
  } else if (method === "action" && object) {
    const command = commandName(object);
    if (command) name = `CLI ${command}`;
  } else if (EVENT_METHODS.has(method) && literal && object) {
    name = `${dottedPath(object.text).at(-1) ?? "emitter"}.${method}("${literal}")`;
  }
  if (name === null) return null;

  // 同一文件里同名注册（不同子应用挂同一路由）要能区分，否则调用会全记到第一个头上
  const taken = existing.filter((s) => s.name === name || s.name.startsWith(`${name} #`)).length;
  const unique = taken === 0 ? name : `${name} #${taken + 1}`;
  return {
    name: unique,
    kind: "function",
    exported: false,
    signature: `${unique} ${signatureOf(handler)}`.slice(0, 400),
    params: extractParams(fieldNode(handler, "parameters") ?? fieldNode(handler, "parameter")),
    returnType: typeAnnotationText(fieldNode(handler, "return_type")),
    startLine: lineOf(handler),
    endLine: handler.endPosition.row + 1,
    startByte: handler.startIndex,
    endByte: handler.endIndex,
    complexity: complexityOf(handler, TS_DECISIONS),
    isAsync: handler.text.startsWith("async"),
  };
}

/** 沿 `program.command("scan [path]").option(…).action` 的链找命令名 */
function commandName(node: TsNode): string | null {
  let cursor: TsNode | null = node;
  while (cursor) {
    if (cursor.type === "call_expression") {
      const fn = fieldNode(cursor, "function");
      if (fn?.type === "member_expression" && fieldText(fn, "property") === "command") {
        const literal = stringLiteral(firstArg(cursor));
        return literal?.trim().split(/\s+/)[0] || null;
      }
      cursor = fn?.type === "member_expression" ? fieldNode(fn, "object") : null;
    } else if (cursor.type === "member_expression") {
      cursor = fieldNode(cursor, "object");
    } else {
      return null;
    }
  }
  return null;
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

/**
 * 声明本身挂在 `export` 下。只看祖先会把 `export function a() { const b = () => {} }`
 * 里的 b 也算成导出，链接器随后会把别处同名调用连到这个闭包上。
 */
function isDirectlyExported(node: TsNode): boolean {
  let parent = node.parent;
  if (node.type === "variable_declarator" &&
      (parent?.type === "lexical_declaration" || parent?.type === "variable_declaration")) {
    parent = parent.parent;
  }
  return parent?.type === "export_statement";
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

  if (/^(?:@[\s\S]*?\s)?export\s+default\b/.test(node.text)) {
    const declaration = fieldNode(node, "declaration");
    const value = fieldNode(node, "value");
    const local = declaration
      ? fieldText(declaration, "name")
      : value?.type === "identifier" ? value.text : null;
    exports.push({ name: "default", kind: "default", local: local ?? undefined, line });
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
      exports.push({ name: fieldText(spec, "alias") ?? name, kind: "named", local: name, line });
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

/**
 * `<Comp prop={…}/>` 就是一次对 Comp 的调用：不收的话 React 前端的组件树整棵看不见。
 * 小写开头是宿主元素（div、svg:rect），不是用户代码。实参记属性名，比属性值更能说明组件接了什么。
 */
function collectJsxElement(node: TsNode, out: RawCallSite[]): void {
  const nameNode = fieldNode(node, "name");
  if (!nameNode || nameNode.type === "jsx_namespace_name") return;
  const path = dottedPath(nameNode.text);
  const callee = path.at(-1);
  if (!callee || !/^[A-Z]/.test(path[0] ?? "")) return;
  const props = namedChildren(node)
    .filter((c) => c.type === "jsx_attribute" || c.type === "jsx_expression")
    .map((c) => (c.type === "jsx_attribute" ? (namedChildren(c)[0]?.text ?? "") : normalizeWhitespace(c.text)))
    .filter(Boolean);
  out.push({
    callee,
    receiver: path.length > 1 ? path.slice(0, -1).join(".") : undefined,
    calleePath: path.length > 1 ? path : undefined,
    line: lineOf(node),
    argCount: props.length,
    argumentTexts: props.slice(0, 12).map((p) => p.slice(0, 240)),
    kind: "render",
    byte: node.startIndex,
    endByte: node.endIndex,
    ...calleeAt(nameNode, callee),
  });
}

function collectCall(node: TsNode, out: RawCallSite[], imports: ParsedImport[]): void {
  const fn = fieldNode(node, "function");
  if (!fn) return;

  // require("x") 与 import("x") 是隐藏的模块依赖，不识别会漏掉整个 CJS 生态
  if (fn.type === "identifier" && fn.text === "require") {
    const source = stringLiteral(firstArg(node));
    if (source !== null) {
      imports.push({ source, kind: "require", specifiers: requireSpecifiers(node), line: lineOf(node) });
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
  const args = argumentTexts(fieldNode(node, "arguments"));

  if (fn.type === "identifier") {
    out.push({
      callee: fn.text,
      line: lineOf(node),
      argCount,
      argumentTexts: args,
      kind: "call",
      byte: node.startIndex,
      endByte: node.endIndex,
      ...calleeAt(fn, fn.text),
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
      argumentTexts: args,
      kind: "method",
      byte: node.startIndex,
      endByte: node.endIndex,
      ...calleeAt(fn, property),
    });
  }
}

/** `const x = require("m")` 与 `const { a, b: c } = require("m")` 的本地绑定 */
function requireSpecifiers(callNode: TsNode): ParsedImportSpecifier[] {
  const declarator = callNode.parent;
  if (declarator?.type !== "variable_declarator") return [];
  if (fieldNode(declarator, "value")?.startIndex !== callNode.startIndex) return [];
  const name = fieldNode(declarator, "name");
  if (!name) return [];
  if (name.type === "identifier") return [{ imported: "*", local: name.text, isNamespace: true }];
  if (name.type !== "object_pattern") return [];
  const out: ParsedImportSpecifier[] = [];
  for (const prop of namedChildren(name)) {
    if (prop.type === "shorthand_property_identifier_pattern") {
      out.push({ imported: prop.text, local: prop.text });
    } else if (prop.type === "pair_pattern") {
      const key = fieldText(prop, "key");
      const value = fieldNode(prop, "value");
      if (key !== null && value?.type === "identifier") out.push({ imported: key, local: value.text });
    }
  }
  return out;
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
