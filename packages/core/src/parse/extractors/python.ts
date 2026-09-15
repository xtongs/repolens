import type {
  ParsedExport,
  ParsedFile,
  ParsedImport,
  ParsedImportSpecifier,
  ParsedParam,
  ParsedSymbol,
  ParsedTypeRelation,
} from "../../types.js";
import {
  ancestorOfType,
  attributeCalls,
  complexityOf,
  dottedPath,
  fieldNode,
  fieldText,
  firstOfType,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  PY_DECISIONS,
  pythonDocstring,
  signatureOf,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

/** 判定顶层常量的命名约定；允许前导下划线以便识别私有常量 */
const CONSTANT_NAME = /^_*[A-Z][A-Z0-9_]*$/;

/** 找最近的「归属容器」时只认这三类：类体里的函数是方法，函数体里的函数不是 */
const OWNER_TYPES = ["class_definition", "function_definition", "lambda"] as const;

/**
 * Python 抽取器。
 *
 * Python 没有 export 语法，可见性只能靠约定推断：优先信 `__all__`，
 * 没有 `__all__` 时退回下划线前缀约定。两者都只约束模块顶层符号，
 * 类成员一律用下划线规则（`__all__` 在语义上管不到类成员）。
 */
export const pythonExtractor: LanguageExtractor = {
  family: "python",
  extract(input: ExtractInput): ParsedFile {
    const { root } = input;
    const dunderAll = readDunderAll(root);

    const symbols: ParsedSymbol[] = [];
    const moduleLevel: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const callSites: RawCallSite[] = [];

    const record = (symbol: ParsedSymbol, isModuleLevel: boolean): void => {
      symbols.push(symbol);
      if (isModuleLevel) moduleLevel.push(symbol);
    };

    walk(root, (node) => {
      switch (node.type) {
        case "import_statement":
          collectImport(node, imports);
          return false;

        case "import_from_statement":
          collectImportFrom(node, imports);
          return false;

        // 装饰器里的 `@app.route(...)` 是元数据而不是运行时调用边
        case "decorator":
          return false;

        case "function_definition": {
          const owner = ancestorOfType(node, OWNER_TYPES);
          record(functionSymbol(node, owner, dunderAll), owner === null);
          return true;
        }

        case "class_definition": {
          const owner = ancestorOfType(node, OWNER_TYPES);
          record(classSymbol(node, owner, dunderAll), owner === null);
          collectBases(node, typeRelations);
          return true;
        }

        case "assignment": {
          const symbol = constantSymbol(node, dunderAll);
          if (symbol) record(symbol, true);
          return true;
        }

        case "call":
          collectCall(node, callSites);
          return true;

        default:
          return true;
      }
    });

    return {
      symbols,
      imports,
      exports: buildExports(moduleLevel, dunderAll, root),
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
  owner: TsNode | null,
  dunderAll: ReadonlySet<string> | null,
): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  const container = containerName(owner);
  const decorators = decoratorNames(node);

  return {
    name,
    kind: container === undefined ? "function" : "method",
    container,
    exported: isExported(name, owner === null, dunderAll),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "return_type")),
    doc: pythonDocstring(fieldNode(node, "body")),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, PY_DECISIONS),
    isAsync: node.text.startsWith("async"),
    isStatic: decorators.includes("staticmethod") || decorators.includes("classmethod"),
  };
}

function classSymbol(
  node: TsNode,
  owner: TsNode | null,
  dunderAll: ReadonlySet<string> | null,
): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  return {
    name,
    kind: "class",
    container: containerName(owner),
    exported: isExported(name, owner === null, dunderAll),
    signature: signatureOf(node, ["body"]),
    doc: pythonDocstring(fieldNode(node, "body")),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: 1,
  };
}

/** 只收模块顶层的大写名赋值：函数体里的局部变量不是架构信息 */
function constantSymbol(node: TsNode, dunderAll: ReadonlySet<string> | null): ParsedSymbol | null {
  const statement = node.parent;
  if (statement?.type !== "expression_statement" || statement.parent?.type !== "module") return null;

  const left = fieldNode(node, "left");
  if (!left || left.type !== "identifier" || !CONSTANT_NAME.test(left.text)) return null;

  return {
    name: left.text,
    kind: "constant",
    exported: isExported(left.text, true, dunderAll),
    signature: normalizeWhitespace(node.text).slice(0, 200),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: 1,
  };
}

function containerName(owner: TsNode | null): string | undefined {
  if (owner?.type !== "class_definition") return undefined;
  return fieldText(owner, "name") ?? undefined;
}

function decoratorNames(node: TsNode): string[] {
  const parent = node.parent;
  if (parent?.type !== "decorated_definition") return [];
  const out: string[] = [];
  for (const child of namedChildren(parent)) {
    if (child.type !== "decorator") continue;
    const path = dottedPath(child.text.replace(/^@/, "").replace(/\(.*$/s, ""));
    const last = path.at(-1);
    if (last !== undefined) out.push(last);
  }
  return out;
}

function isExported(
  name: string,
  isModuleLevel: boolean,
  dunderAll: ReadonlySet<string> | null,
): boolean {
  if (isModuleLevel && dunderAll) return dunderAll.has(name);
  return !name.startsWith("_");
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function extractParams(paramsNode: TsNode | null): ParsedParam[] | undefined {
  if (!paramsNode) return undefined;

  const out: ParsedParam[] = [];
  for (const child of namedChildren(paramsNode)) {
    switch (child.type) {
      // `self` / `cls` 不做特殊处理，如实记为第一个参数
      case "identifier":
        out.push({ name: child.text, optional: false, variadic: false });
        break;

      case "typed_parameter": {
        // typed_parameter 没有 name 字段，名字是第一个命名子节点
        const target = child.namedChild(0);
        const splat = target?.type === "list_splat_pattern" || target?.type === "dictionary_splat_pattern";
        out.push({
          name: splat ? splatName(target) : normalizeWhitespace(target?.text ?? "_"),
          type: annotationText(fieldNode(child, "type")),
          optional: splat,
          variadic: splat,
        });
        break;
      }

      case "default_parameter":
      case "typed_default_parameter":
        out.push({
          name: fieldText(child, "name") ?? "_",
          type: annotationText(fieldNode(child, "type")),
          defaultValue: normalizeWhitespace(fieldNode(child, "value")?.text ?? "").slice(0, 120) || undefined,
          optional: true,
          variadic: false,
        });
        break;

      case "list_splat_pattern":
      case "dictionary_splat_pattern":
        out.push({ name: splatName(child), optional: true, variadic: true });
        break;

      // keyword_separator(`*`) / positional_separator(`/`) 不是参数
      default:
        break;
    }
  }
  return out;
}

/** `*args` → `args`，`**kwargs` → `kwargs` */
function splatName(node: TsNode | null): string {
  if (!node) return "_";
  return node.namedChild(0)?.text ?? normalizeWhitespace(node.text);
}

function annotationText(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const text = normalizeWhitespace(node.text);
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

// ---------------------------------------------------------------------------
// import / export
// ---------------------------------------------------------------------------

/** `import a.b.c` / `import a.b as x` / `import a, b` */
function collectImport(node: TsNode, out: ParsedImport[]): void {
  const line = lineOf(node);
  for (const child of namedChildren(node)) {
    if (child.type === "dotted_name") {
      out.push({
        source: child.text,
        kind: "static",
        specifiers: [{ imported: "*", local: child.text, isNamespace: true }],
        line,
      });
      continue;
    }
    if (child.type === "aliased_import") {
      const source = fieldText(child, "name");
      if (source === null || source.length === 0) continue;
      out.push({
        source,
        kind: "static",
        specifiers: [{ imported: "*", local: fieldText(child, "alias") ?? source, isNamespace: true }],
        line,
      });
    }
  }
}

/**
 * `from .x import y` / `from ..x import y as z` / `from x import *`
 *
 * source 保留 `relative_import` 的原始点号（`.` / `..x`），解析器靠点数回溯包层级，
 * 归一化掉就再也分不清 `.x` 和 `..x`。
 */
function collectImportFrom(node: TsNode, out: ParsedImport[]): void {
  const children = namedChildren(node);
  const moduleNode = children[0];
  if (!moduleNode) return;

  const specifiers: ParsedImportSpecifier[] = [];
  for (const child of children.slice(1)) {
    switch (child.type) {
      case "wildcard_import":
        specifiers.push({ imported: "*", local: "*", isNamespace: true });
        break;
      case "dotted_name":
        specifiers.push({ imported: child.text, local: child.text });
        break;
      case "aliased_import": {
        const imported = fieldText(child, "name");
        if (imported === null || imported.length === 0) break;
        specifiers.push({ imported, local: fieldText(child, "alias") ?? imported });
        break;
      }
      default:
        break;
    }
  }

  out.push({
    source: normalizeWhitespace(moduleNode.text),
    kind: "static",
    specifiers,
    line: lineOf(node),
  });
}

function readDunderAll(root: TsNode): ReadonlySet<string> | null {
  for (const statement of namedChildren(root)) {
    if (statement.type !== "expression_statement") continue;
    const assignment = firstOfType(statement, "assignment", "augmented_assignment");
    if (!assignment || fieldText(assignment, "left") !== "__all__") continue;

    const right = fieldNode(assignment, "right");
    if (!right || (right.type !== "list" && right.type !== "tuple")) continue;

    const names = new Set<string>();
    for (const item of namedChildren(right)) {
      if (item.type !== "string") continue;
      const content = firstOfType(item, "string_content");
      if (content) names.add(content.text);
    }
    return names;
  }
  return null;
}

function buildExports(
  moduleLevel: readonly ParsedSymbol[],
  dunderAll: ReadonlySet<string> | null,
  root: TsNode,
): ParsedExport[] {
  if (dunderAll) {
    const lineByName = new Map(moduleLevel.map((s) => [s.name, s.startLine]));
    const fallback = dunderAllLine(root);
    // `__all__` 可以列出本文件没定义的名字（转发导入），这些也算导出
    return [...dunderAll].map((name) => ({
      name,
      kind: "named" as const,
      line: lineByName.get(name) ?? fallback,
    }));
  }
  return moduleLevel
    .filter((s) => !s.name.startsWith("_"))
    .map((s) => ({ name: s.name, kind: "named" as const, line: s.startLine }));
}

function dunderAllLine(root: TsNode): number {
  for (const statement of namedChildren(root)) {
    if (statement.type !== "expression_statement") continue;
    const assignment = firstOfType(statement, "assignment", "augmented_assignment");
    if (assignment && fieldText(assignment, "left") === "__all__") return lineOf(assignment);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

function collectCall(node: TsNode, out: RawCallSite[]): void {
  const fn = fieldNode(node, "function");
  if (!fn) return;

  const argCount = countArgs(fieldNode(node, "arguments"));
  const line = lineOf(node);
  const byte = node.startIndex;

  if (fn.type === "identifier") {
    out.push({ callee: fn.text, line, argCount, kind: "call", byte });
    return;
  }

  if (fn.type === "attribute") {
    const callee = fieldText(fn, "attribute");
    if (callee === null) return;
    const object = fieldNode(fn, "object");
    const path = dottedPath(fn.text);
    out.push({
      callee,
      receiver: object ? normalizeWhitespace(object.text).slice(0, 120) : undefined,
      calleePath: path.length > 1 ? path : undefined,
      line,
      argCount,
      kind: "method",
      byte,
    });
  }
  // `handlers[k]()` / `f()()` 的被调方无法静态命名，不记录
}

function countArgs(argsNode: TsNode | null): number {
  if (!argsNode) return 0;
  return namedChildren(argsNode).filter((c) => c.type !== "comment").length;
}

// ---------------------------------------------------------------------------
// 类型关系
// ---------------------------------------------------------------------------

function collectBases(node: TsNode, out: ParsedTypeRelation[]): void {
  const subject = fieldText(node, "name");
  const supers = fieldNode(node, "superclasses");
  if (subject === null || !supers) return;

  for (const child of namedChildren(supers)) {
    // `metaclass=ABCMeta` 是类创建参数，不是基类
    if (child.type === "keyword_argument") continue;
    // `Generic[T]` 的基类是 `Generic`，类型参数丢掉
    const base = child.type === "subscript" ? fieldNode(child, "value") : child;
    if (!base) continue;

    const path = dottedPath(base.text);
    const target = path.at(-1);
    if (target === undefined) continue;

    out.push({
      subject,
      subjectKind: "class",
      relation: "extends",
      target,
      targetPath: path.length > 1 ? path : undefined,
      line: lineOf(child),
    });
  }
}
