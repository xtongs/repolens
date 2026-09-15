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
  ancestorOfType,
  attributeCalls,
  complexityOf,
  docCommentAbove,
  dottedPath,
  fieldNode,
  fieldText,
  firstOfType,
  lineOf,
  namedChildren,
  normalizeWhitespace,
  RUST_DECISIONS,
  signatureOf,
  walk,
  type RawCallSite,
} from "../ast-utils.js";
import type { ExtractInput, LanguageExtractor, TsNode } from "./types.js";

const COMMENT_TYPES = ["line_comment", "block_comment"] as const;

/** 找函数归属时的候选容器；命中 function_item/闭包说明这是嵌套函数，不是方法 */
const OWNER_TYPES = ["impl_item", "trait_item", "function_item", "closure_expression"] as const;

const DECLARED_TYPE_KINDS = new Set<SymbolKind>(["struct", "enum", "trait", "type"]);

/**
 * Rust 抽取器。
 *
 * 与其他语言最大的差别是模块树不由目录结构隐含决定，而是由 `mod foo;` 声明驱动。
 * 这里除了把名字放进 `moduleDecls`，还额外产出一条 `module-decl` 的 ParsedImport，
 * 让模块解析器能用同一条通路把 `mod foo;` 落到 `foo.rs` / `foo/mod.rs`。
 */
export const rustExtractor: LanguageExtractor = {
  family: "rust",
  extract(input: ExtractInput): ParsedFile {
    const { root } = input;
    const symbols: ParsedSymbol[] = [];
    const imports: ParsedImport[] = [];
    const typeRelations: ParsedTypeRelation[] = [];
    const moduleDecls: string[] = [];
    const callSites: RawCallSite[] = [];

    walk(root, (node) => {
      switch (node.type) {
        case "use_declaration":
          collectUse(node, imports);
          return false;

        case "mod_item": {
          const name = fieldText(node, "name");
          if (name === null) return false;
          if (fieldNode(node, "body") === null) {
            moduleDecls.push(name);
            imports.push({
              source: `self::${name}`,
              kind: "module-decl",
              specifiers: [{ imported: "*", local: name, isNamespace: true }],
              line: lineOf(node),
            });
            return false;
          }
          symbols.push(declarationSymbol(node, "module", name));
          return true;
        }

        case "function_item":
        case "function_signature_item":
          symbols.push(functionSymbol(node));
          return true;

        case "struct_item":
        case "union_item":
          symbols.push(declarationSymbol(node, "struct"));
          return true;

        case "enum_item":
          symbols.push(declarationSymbol(node, "enum"));
          return true;

        case "trait_item":
          symbols.push(declarationSymbol(node, "trait"));
          collectSupertraits(node, typeRelations);
          return true;

        case "type_item":
          symbols.push(declarationSymbol(node, "type"));
          return true;

        case "impl_item":
          symbols.push(implSymbol(node));
          collectImplRelation(node, symbols, typeRelations);
          return true;

        case "const_item":
        case "static_item":
          symbols.push(declarationSymbol(node, "constant"));
          return true;

        case "call_expression":
          collectCall(node, callSites);
          return true;

        case "macro_invocation":
          collectMacro(node, callSites);
          // token_tree 里是未解析的 token 流，不含 call_expression，没必要深入
          return false;

        default:
          return true;
      }
    });

    return {
      symbols,
      imports,
      exports: symbols
        .filter((s) => s.exported && s.container === undefined && s.kind !== "impl")
        .map((s): ParsedExport => ({ name: s.name, kind: "named", line: s.startLine })),
      calls: attributeCalls(symbols, callSites),
      typeRelations,
      moduleDecls,
      hasError: root.hasError,
    };
  },
};

// ---------------------------------------------------------------------------
// 符号
// ---------------------------------------------------------------------------

function functionSymbol(node: TsNode): ParsedSymbol {
  const name = fieldText(node, "name") ?? "<anonymous>";
  const owner = ancestorOfType(node, OWNER_TYPES);
  const container = memberContainer(owner);

  return {
    name,
    kind: container === undefined ? "function" : "method",
    container,
    exported: isExported(node),
    signature: signatureOf(node),
    params: extractParams(fieldNode(node, "parameters")),
    returnType: annotationText(fieldNode(node, "return_type")),
    doc: docOf(node),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: complexityOf(node, RUST_DECISIONS),
    isAsync: firstOfType(node, "function_modifiers")?.text.includes("async") ?? false,
  };
}

function declarationSymbol(node: TsNode, kind: SymbolKind, nameOverride?: string): ParsedSymbol {
  return {
    name: nameOverride ?? fieldText(node, "name") ?? "<anonymous>",
    kind,
    exported: isExported(node),
    signature: signatureOf(node, ["body"]),
    doc: docOf(node),
    startLine: lineOf(node),
    endLine: node.endPosition.row + 1,
    startByte: node.startIndex,
    endByte: node.endIndex,
    complexity: 1,
  };
}

/** impl 块没有名字，用 `Type` 或 `Trait for Type` 当可读标识 */
function implSymbol(node: TsNode): ParsedSymbol {
  const subject = typeNameOf(fieldNode(node, "type")) ?? "<unknown>";
  const trait = typeNameOf(fieldNode(node, "trait"));
  return {
    ...declarationSymbol(node, "impl", trait === undefined ? subject : `${trait} for ${subject}`),
    // impl 块本身的可见性没有意义，可见性由其中的每个成员各自声明
    exported: false,
  };
}

function memberContainer(owner: TsNode | null): string | undefined {
  if (owner === null) return undefined;
  if (owner.type === "impl_item") return typeNameOf(fieldNode(owner, "type"));
  if (owner.type === "trait_item") return fieldText(owner, "name") ?? undefined;
  return undefined;
}

function isExported(node: TsNode): boolean {
  return firstOfType(node, "visibility_modifier") !== null;
}

/** `&mut Vec<T>` / `crate::a::Type<T>` → `Type` */
function typeNameOf(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const head = node.text.replace(/^[&*\s]+/, "").replace(/^\bmut\b\s*/, "").replace(/<.*$/s, "");
  const last = head
    .split("::")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .at(-1);
  return last === undefined || last.length === 0 ? undefined : last;
}

// ---------------------------------------------------------------------------
// 文档注释
// ---------------------------------------------------------------------------

/**
 * Rust 文档注释。
 *
 * 换行算进注释节点范围的问题已经在 `docCommentAbove` 里按「视觉末行」归一化，
 * 这里只需要处理 Rust 独有的另一件事：`#[derive(..)]` 等属性会横插在注释和
 * 声明之间打断兄弟链，所以先把锚点上移到最上面那条属性。
 */
function docOf(node: TsNode): string | undefined {
  return docCommentAbove(attributeAnchor(node), COMMENT_TYPES);
}

function attributeAnchor(node: TsNode): TsNode {
  let anchor = node;
  for (;;) {
    const prev: TsNode | null = anchor.previousSibling;
    if (!prev || prev.type !== "attribute_item") return anchor;
    if (prev.endPosition.row !== anchor.startPosition.row - 1) return anchor;
    anchor = prev;
  }
}

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

function extractParams(paramsNode: TsNode | null): ParsedParam[] | undefined {
  if (!paramsNode) return undefined;

  const out: ParsedParam[] = [];
  for (const child of namedChildren(paramsNode)) {
    switch (child.type) {
      case "parameter":
        out.push({
          name: normalizeWhitespace(fieldNode(child, "pattern")?.text ?? "_").slice(0, 120),
          type: annotationText(fieldNode(child, "type")),
          optional: false,
          variadic: false,
        });
        break;
      case "self_parameter":
        // `&self` / `&mut self` / `self`：类型信息就在原文里
        out.push({ name: "self", type: normalizeWhitespace(child.text), optional: false, variadic: false });
        break;
      case "variadic_parameter":
        out.push({ name: "...", optional: false, variadic: true });
        break;
      default:
        break;
    }
  }
  return out;
}

function annotationText(node: TsNode | null): string | undefined {
  if (!node) return undefined;
  const text = normalizeWhitespace(node.text);
  return text.length > 0 ? text.slice(0, 200) : undefined;
}

// ---------------------------------------------------------------------------
// use 声明
// ---------------------------------------------------------------------------

interface UseLeaf {
  /** 完整路径段，如 `["crate","store","models","User"]` */
  segments: string[];
  alias?: string | undefined;
  wildcard?: boolean | undefined;
}

/**
 * 把 `use a::{b, c::d}` 展平成每个叶子一条记录。
 *
 * `source` 只保留模块路径（去掉最后一段的符号名），这样解析器拿到的永远是
 * 可以往文件上落的东西；最后一段作为 specifier 交给符号级解析。
 */
function collectUse(node: TsNode, out: ParsedImport[]): void {
  const argument = fieldNode(node, "argument");
  if (!argument) return;

  const line = lineOf(node);
  for (const leaf of useLeaves(argument, [])) {
    const binding = bindingOf(leaf);
    if (binding) out.push({ ...binding, kind: "static", line });
  }
}

/** 把叶子路径切成「模块路径」和「绑定名」两半 */
function bindingOf(leaf: UseLeaf): Pick<ParsedImport, "source" | "specifiers"> | null {
  const last = leaf.segments.at(-1);
  if (last === undefined) return null;

  // 通配导入整条路径都是模块路径，没有可切下来的符号名
  if (leaf.wildcard === true) {
    return {
      source: leaf.segments.join("::"),
      specifiers: [{ imported: "*", local: "*", isNamespace: true }],
    };
  }

  // `use foo;` 和 `use a::{self}` 导入的是模块本身，同样没有符号级最后一段
  if (last === "self" || leaf.segments.length === 1) {
    const segments = last === "self" ? leaf.segments.slice(0, -1) : leaf.segments;
    const name = segments.at(-1);
    if (name === undefined) return null;
    return {
      source: segments.join("::"),
      specifiers: [{ imported: "*", local: leaf.alias ?? name, isNamespace: true }],
    };
  }

  return {
    source: leaf.segments.slice(0, -1).join("::"),
    specifiers: [{ imported: last, local: leaf.alias ?? last }],
  };
}

function useLeaves(node: TsNode, prefix: readonly string[]): UseLeaf[] {
  switch (node.type) {
    case "scoped_use_list": {
      const path = [...prefix, ...pathSegments(fieldNode(node, "path"))];
      const list = fieldNode(node, "list");
      return list ? namedChildren(list).flatMap((item) => useLeaves(item, path)) : [];
    }
    case "use_list":
      return namedChildren(node).flatMap((item) => useLeaves(item, prefix));
    case "use_as_clause": {
      const path = fieldNode(node, "path");
      if (!path) return [];
      const alias = fieldText(node, "alias") ?? undefined;
      return useLeaves(path, prefix).map((leaf) => ({ ...leaf, alias }));
    }
    case "use_wildcard":
      return [{ segments: [...prefix, ...pathSegments(node)], wildcard: true }];
    case "scoped_identifier":
    case "identifier":
    case "crate":
    case "super":
    case "self":
      return [{ segments: [...prefix, ...pathSegments(node)] }];
    default:
      return [];
  }
}

/**
 * 按 `::` 切路径原文。
 *
 * 不递归 path/name 字段是因为前导 `::`（`use ::global::Thing`）在语法树里没有
 * 对应的命名节点，只有原文才完整；空段和 `*` 一并丢掉即可。
 */
function pathSegments(node: TsNode | null): string[] {
  if (!node) return [];
  return node.text
    .split("::")
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s !== "*");
}

// ---------------------------------------------------------------------------
// 调用
// ---------------------------------------------------------------------------

function collectCall(node: TsNode, out: RawCallSite[]): void {
  const fn = fieldNode(node, "function");
  if (!fn) return;

  // 显式泛型 `parse::<u32>()`：真正的被调方在 generic_function 的 function 字段上
  const target = fn.type === "generic_function" ? fieldNode(fn, "function") : fn;
  if (!target) return;

  const argCount = countArgs(fieldNode(node, "arguments"));
  const line = lineOf(node);
  const byte = node.startIndex;

  if (target.type === "identifier") {
    out.push({ callee: target.text, line, argCount, kind: "call", byte });
    return;
  }

  if (target.type === "scoped_identifier") {
    const segments = pathSegments(target);
    const callee = segments.at(-1);
    if (callee === undefined) return;
    // `Store::open()` 是关联函数而不是实例方法，归为普通 call
    out.push({
      callee,
      receiver: segments.length > 1 ? segments.slice(0, -1).join("::") : undefined,
      calleePath: segments.length > 1 ? segments : undefined,
      line,
      argCount,
      kind: "call",
      byte,
    });
    return;
  }

  if (target.type === "field_expression") {
    const callee = fieldText(target, "field");
    if (callee === null) return;
    const value = fieldNode(target, "value");
    const path = dottedPath(target.text);
    out.push({
      callee,
      receiver: value ? normalizeWhitespace(value.text).slice(0, 120) : undefined,
      calleePath: path.length > 1 ? path : undefined,
      line,
      argCount,
      kind: "method",
      byte,
    });
  }
}

function collectMacro(node: TsNode, out: RawCallSite[]): void {
  const callee = typeNameOf(fieldNode(node, "macro"));
  if (callee === undefined) return;
  const tree = firstOfType(node, "token_tree");
  out.push({
    callee,
    // token_tree 没有参数结构，用命名 token 数近似（`,` 是匿名节点，不计入）
    argCount: tree ? namedChildren(tree).length : 0,
    line: lineOf(node),
    kind: "macro",
    byte: node.startIndex,
  });
}

function countArgs(argsNode: TsNode | null): number {
  if (!argsNode) return 0;
  return namedChildren(argsNode).filter(
    (c) => c.type !== "line_comment" && c.type !== "block_comment",
  ).length;
}

// ---------------------------------------------------------------------------
// 类型关系
// ---------------------------------------------------------------------------

function collectImplRelation(
  node: TsNode,
  known: readonly ParsedSymbol[],
  out: ParsedTypeRelation[],
): void {
  const traitNode = fieldNode(node, "trait");
  if (!traitNode) return;

  const subject = typeNameOf(fieldNode(node, "type"));
  const target = typeNameOf(traitNode);
  if (subject === undefined || target === undefined) return;

  out.push({
    subject,
    subjectKind: declaredKindOf(subject, known),
    relation: "implements",
    target,
    targetPath: qualifiedPath(traitNode),
    line: lineOf(node),
  });
}

function collectSupertraits(node: TsNode, out: ParsedTypeRelation[]): void {
  const subject = fieldText(node, "name");
  const bounds = fieldNode(node, "bounds");
  if (subject === null || !bounds) return;

  for (const bound of namedChildren(bounds)) {
    // 生命周期约束（`'a`）和负向约束（`?Sized`）不是父 trait
    if (bound.type === "lifetime" || bound.type === "removed_trait_bound") continue;
    const target = typeNameOf(bound);
    if (target === undefined) continue;
    out.push({
      subject,
      subjectKind: "trait",
      relation: "extends",
      target,
      targetPath: qualifiedPath(bound),
      line: lineOf(bound),
    });
  }
}

/** 限定路径，如 `serde::Serialize`；泛型段丢掉，单段路径没有信息量返回 undefined */
function qualifiedPath(node: TsNode): string[] | undefined {
  const path = pathSegments(node).filter((s) => !s.includes("<"));
  return path.length > 1 ? path : undefined;
}

/**
 * impl 块只写了类型名，看不出它是 struct 还是 enum。
 * 同文件里通常能找到声明，找不到时退回 `struct`（最常见的情况）。
 */
function declaredKindOf(name: string, known: readonly ParsedSymbol[]): SymbolKind {
  const hit = known.find((s) => s.name === name && DECLARED_TYPE_KINDS.has(s.kind));
  return hit?.kind ?? "struct";
}
