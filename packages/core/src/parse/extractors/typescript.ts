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
    const hints = new ReceiverHints();

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
          collectCall(node, callSites, imports, hints);
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

function collectCall(node: TsNode, out: RawCallSite[], imports: ParsedImport[], hints: ReceiverHints): void {
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
      receiverType: hints.of(fn),
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
      receiverType: objectNode ? hints.of(objectNode) : undefined,
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

const FUNCTION_SCOPES = new Set([
  "function_declaration", "generator_function_declaration", "function_expression", "function",
  "generator_function", "arrow_function", "method_definition",
]);

interface Declaration {
  start: number;
  /** undefined 表示声明了但看不出类型 */
  hint: string | undefined;
}

/**
 * 方法调用接收者的类型线索（格式见 ParsedCall.receiverType），链接阶段据此找到方法。
 *
 * 只认写在源码里的几种：参数标注、`const x: T`、`new T()`、`x as T`、`const x = f()`、
 * 类字段与构造器参数属性。沿作用域往外找，碰到同名但看不出类型的绑定就停——
 * 越过它拿到外层同名变量的类型，比不知道更糟。
 */
class ReceiverHints {
  /** 语句块 id → 名字 → 块内的声明；一个文件里同一个块会被它里面的每个调用问到 */
  private readonly blocks = new Map<number, Map<string, Declaration[]>>();

  of(object: TsNode): string | undefined {
    const node = unwrapExpression(object);
    switch (node.type) {
      case "identifier":
        return this.binding(node.text, node);
      case "member_expression": {
        const property = fieldText(node, "property");
        if (fieldNode(node, "object")?.type === "this") return property ? classFieldHint(property, node) : undefined;
        // `c.req.json()`：属性的类型不知道，但根变量属于某个外部库时，属性多半也是那个库的对象
        let root: TsNode | null = node;
        while (root?.type === "member_expression") root = fieldNode(root, "object");
        const rootHint = root?.type === "identifier" ? this.binding(root.text, root) : undefined;
        return rootHint ? `M:${rootHint}` : undefined;
      }
      // `a().b()` 交给链接阶段：内层调用自己有接收者线索，拿它的解析结果比重新解析路径准
      case "call_expression":
        return undefined;
      default:
        return valueHint(node);
    }
  }

  private binding(name: string, from: TsNode): string | undefined {
    let insideClosure = false;
    for (let scope = from.parent; scope; scope = scope.parent) {
      if (FUNCTION_SCOPES.has(scope.type)) {
        const param = paramDeclaration(scope, name);
        // P: 只告诉走读界面「这是参数传进来的」，链接阶段不拿它解析
        if (param !== null) return param.hint ?? this.callbackHint(scope) ?? "P:";
        insideClosure = true;
        continue;
      }
      if (scope.type === "statement_block" || scope.type === "program") {
        // 闭包里用到的变量可以声明在闭包之后：调用发生时外层早已执行完
        const found = this.declarations(scope)
          .get(name)
          ?.find((d) => insideClosure || d.start < from.startIndex);
        if (found) return found.hint;
        continue;
      }
      const loopBinding =
        scope.type === "for_in_statement" ? fieldNode(scope, "left")
        : scope.type === "catch_clause" ? fieldNode(scope, "parameter")
        : scope.type === "for_statement" ? fieldNode(scope, "initializer")
        : null;
      if (loopBinding && bindsName(loopBinding, name)) return undefined;
    }
    return undefined;
  }

  /**
   * 没标类型的回调参数：`app.get("/x", (c) => …)` 里的 c 由 app.get 传进来。
   * 记下注册方法名和它接收者的线索，链接阶段确认 app.get 落在外部库上时，c 也归那个库。
   */
  private callbackHint(fn: TsNode): string | undefined {
    if (fn.type !== "arrow_function" && fn.type !== "function_expression" && fn.type !== "function") return undefined;
    const call = fn.parent?.type === "arguments" ? fn.parent.parent : null;
    const callee = call?.type === "call_expression" ? fieldNode(call, "function") : null;
    if (callee?.type !== "member_expression") return undefined;
    const method = fieldText(callee, "property");
    const object = fieldNode(callee, "object");
    const owner = object && object.type !== "call_expression" ? this.of(object) : undefined;
    return method && owner ? `C:${method}|${owner}` : undefined;
  }

  private declarations(block: TsNode): Map<string, Declaration[]> {
    const cached = this.blocks.get(block.id);
    if (cached) return cached;
    const table = new Map<string, Declaration[]>();
    const add = (name: string, start: number, hint: string | undefined) => {
      const list = table.get(name);
      if (list) list.push({ start, hint });
      else table.set(name, [{ start, hint }]);
    };
    for (const statement of namedChildren(block)) {
      const decl = statement.type === "export_statement" ? fieldNode(statement, "declaration") : statement;
      if (!decl) continue;
      if (decl.type === "lexical_declaration" || decl.type === "variable_declaration") {
        for (const declarator of namedChildren(decl)) {
          if (declarator.type !== "variable_declarator") continue;
          const id = fieldNode(declarator, "name");
          if (id?.type === "identifier") {
            add(id.text, statement.startIndex, declaratorHint(declarator));
            continue;
          }
          // `const [open, setOpen] = useState()`：D: 记下解构自哪次调用，同样只给走读界面解释用
          const value = fieldNode(declarator, "value");
          const source = value ? valueHint(value)?.match(/^[RA]:(.+)$/)?.[1] : undefined;
          if (id) for (const bound of boundNames(id)) add(bound, statement.startIndex, source ? `D:${source}` : undefined);
        }
      } else if (decl.type === "function_declaration" || decl.type === "class_declaration") {
        const id = fieldText(decl, "name");
        if (id) add(id, statement.startIndex, undefined);
      }
    }
    this.blocks.set(block.id, table);
    return table;
  }
}

function unwrapExpression(node: TsNode): TsNode {
  let current = node;
  while (current.type === "parenthesized_expression" || current.type === "non_null_expression") {
    const inner = namedChildren(current)[0];
    if (!inner) break;
    current = inner;
  }
  return current;
}

/** 函数自己的参数里有没有这个名字；null 表示没有，要继续往外找 */
function paramDeclaration(fn: TsNode, name: string): { hint: string | undefined } | null {
  const single = fieldNode(fn, "parameter");
  if (single) return single.text === name ? { hint: undefined } : null;
  const params = fieldNode(fn, "parameters");
  if (!params) return null;
  for (const param of namedChildren(params)) {
    if (param.type === "required_parameter" || param.type === "optional_parameter") {
      const pattern = fieldNode(param, "pattern");
      if (pattern?.type === "identifier" && pattern.text === name) {
        const type = typeAnnotationText(fieldNode(param, "type"));
        const value = fieldNode(param, "value");
        return { hint: type ? `T:${type}` : value ? valueHint(value) : undefined };
      }
      if (pattern && bindsName(pattern, name)) return { hint: undefined };
    } else if (bindsName(param, name)) {
      return { hint: undefined };
    }
  }
  return null;
}

function declaratorHint(declarator: TsNode): string | undefined {
  const type = typeAnnotationText(fieldNode(declarator, "type"));
  if (type) return `T:${type}`;
  const value = fieldNode(declarator, "value");
  return value ? valueHint(value) : undefined;
}

function valueHint(value: TsNode): string | undefined {
  const node = unwrapExpression(value);
  switch (node.type) {
    case "new_expression": {
      const ctor = fieldNode(node, "constructor");
      return ctor && (ctor.type === "identifier" || ctor.type === "member_expression")
        ? `T:${normalizeWhitespace(ctor.text)}`
        : undefined;
    }
    case "as_expression":
    case "satisfies_expression": {
      const [expression, type] = namedChildren(node);
      if (!type) return expression ? valueHint(expression) : undefined;
      return `T:${normalizeWhitespace(type.text).slice(0, 200)}`;
    }
    case "await_expression": {
      const inner = namedChildren(node)[0];
      if (!inner) return undefined;
      const call = unwrapExpression(inner);
      if (call.type !== "call_expression") return valueHint(inner);
      const path = callPath(call);
      return path ? `A:${path}` : undefined;
    }
    case "call_expression": {
      const path = callPath(node);
      return path ? `R:${path}` : undefined;
    }
    default:
      return undefined;
  }
}

/** `f()` / `a.b.f()` 的被调路径；中间夹着调用、下标或可选链的不算 */
function callPath(call: TsNode): string | undefined {
  const fn = fieldNode(call, "function");
  if (!fn || (fn.type !== "identifier" && fn.type !== "member_expression")) return undefined;
  const path = dottedPath(fn.text).join(".");
  return path === fn.text.replace(/\s+/g, "") ? path : undefined;
}

/** `this.db` 的类型：类字段的标注或初值、构造器参数属性、构造器里的 `this.db = …` */
function classFieldHint(property: string, from: TsNode): string | undefined {
  const body = ancestorOfType(from, ["class_body"]);
  if (!body) return undefined;
  for (const member of namedChildren(body)) {
    if (member.type === "public_field_definition" || member.type === "field_definition") {
      const name = fieldNode(member, "name") ?? fieldNode(member, "property");
      if (name?.text !== property) continue;
      const type = typeAnnotationText(fieldNode(member, "type"));
      if (type) return `T:${type}`;
      const value = fieldNode(member, "value");
      return value ? valueHint(value) : undefined;
    }
    if (member.type !== "method_definition" || fieldText(member, "name") !== "constructor") continue;
    for (const param of namedChildren(fieldNode(member, "parameters") ?? member)) {
      if (param.type !== "required_parameter" && param.type !== "optional_parameter") continue;
      if (fieldNode(param, "pattern")?.text !== property) continue;
      const type = typeAnnotationText(fieldNode(param, "type"));
      return type ? `T:${type}` : undefined;
    }
    for (const statement of namedChildren(fieldNode(member, "body") ?? member)) {
      const assignment = statement.type === "expression_statement" ? namedChildren(statement)[0] : null;
      if (assignment?.type !== "assignment_expression") continue;
      const left = fieldNode(assignment, "left");
      if (left?.type !== "member_expression" || fieldNode(left, "object")?.type !== "this") continue;
      if (fieldText(left, "property") !== property) continue;
      const right = fieldNode(assignment, "right");
      return right ? valueHint(right) : undefined;
    }
  }
  return undefined;
}

/** 解构模式、for 循环变量里绑定出来的名字；默认值和初值里出现的名字不算 */
function boundNames(pattern: TsNode, out: string[] = []): string[] {
  switch (pattern.type) {
    case "identifier":
    case "shorthand_property_identifier_pattern":
      out.push(pattern.text);
      break;
    case "assignment_pattern":
    case "object_assignment_pattern":
    case "variable_declarator": {
      const target = fieldNode(pattern, "left") ?? fieldNode(pattern, "name");
      if (target) boundNames(target, out);
      break;
    }
    default:
      for (const child of namedChildren(pattern)) boundNames(child, out);
  }
  return out;
}

function bindsName(pattern: TsNode, name: string): boolean {
  if (pattern.type === "identifier") return pattern.text === name;
  return boundNames(pattern).includes(name);
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
