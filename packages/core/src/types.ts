/**
 * RepoLens 领域类型。
 *
 * 这个文件是整个项目的契约，必须保持**零运行时依赖**：
 * 前端通过 `import type { ... } from "@repolens/core/types"` 直接引用，
 * 一旦这里引入了 node 专属模块，前端构建就会被污染。
 */

// ---------------------------------------------------------------------------
// 基础枚举
// ---------------------------------------------------------------------------

export type Language =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "python"
  | "go"
  | "rust"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "shell"
  | "other";

/** 参与图谱构建的语言（有抽取器） */
export type AnalyzableLanguage = "typescript" | "tsx" | "javascript" | "jsx" | "python" | "go" | "rust";

/**
 * 文件角色。除 `source` 外全部默认从图和统计中折叠，
 * 依据见 docs/INTERACTION.md「噪音默认不参与」。
 */
export type FileRole = "source" | "test" | "config" | "generated" | "types" | "docs" | "asset" | "vendor";

export type SymbolKind =
  | "function"
  | "method"
  | "class"
  | "interface"
  | "struct"
  | "enum"
  | "type"
  | "trait"
  | "impl"
  | "constant"
  | "variable"
  | "module"
  | "property";

export type EdgeType =
  | "contains"
  | "imports"
  | "calls"
  | "extends"
  | "implements"
  | "embeds"
  | "instantiates"
  | "references";

/**
 * 调用/引用边的置信度。语义见 docs/ARCHITECTURE.md#调用边置信度模型。
 * 顺序有意义：exact > likely > ambiguous > external > unresolved。
 */
export type Confidence = "exact" | "likely" | "ambiguous" | "external" | "unresolved";

export const CONFIDENCE_ORDER: readonly Confidence[] = [
  "exact",
  "likely",
  "ambiguous",
  "external",
  "unresolved",
];

export type PackageManager = "pnpm" | "npm" | "yarn" | "go" | "cargo" | "python" | "none";

export type ImportKind = "static" | "dynamic" | "require" | "side-effect" | "re-export" | "module-decl";

export type CallKind = "call" | "method" | "new" | "macro";

// ---------------------------------------------------------------------------
// 抽取器契约 —— 每种语言的 extractor 必须产出下面这些结构
// ---------------------------------------------------------------------------

export interface ParsedParam {
  name: string;
  type?: string | undefined;
  defaultValue?: string | undefined;
  optional: boolean;
  variadic: boolean;
}

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  /** 所属类 / 结构体 / trait 名；顶层符号为 undefined */
  container?: string | undefined;
  exported: boolean;
  /** 原文签名，用于详情面板直接展示 */
  signature?: string | undefined;
  params?: ParsedParam[] | undefined;
  returnType?: string | undefined;
  /** 紧邻的文档注释（JSDoc / docstring / `///`） */
  doc?: string | undefined;
  /** 1-based，闭区间 */
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  /** 圈复杂度近似值，最小为 1 */
  complexity: number;
  isAsync?: boolean | undefined;
  isStatic?: boolean | undefined;
  /** Go 方法接收者类型，如 `*Server` */
  receiverType?: string | undefined;
  /** 结构指纹：忽略名字和字面量后的 AST 形状，用于识别重复实现 */
  shape?: string | null | undefined;
}

export interface ParsedImportSpecifier {
  /** 源模块中的名字；`*` 表示命名空间导入或通配导入 */
  imported: string;
  /** 本地绑定名 */
  local: string;
  isDefault?: boolean | undefined;
  isNamespace?: boolean | undefined;
}

export interface ParsedImport {
  /** 原始说明符文本，如 `./foo`、`github.com/x/y`、`crate::a::b` */
  source: string;
  kind: ImportKind;
  specifiers: ParsedImportSpecifier[];
  line: number;
  isTypeOnly?: boolean | undefined;
}

export interface ParsedExport {
  name: string;
  kind: "named" | "default" | "star" | "star-as";
  /** re-export 的来源说明符 */
  source?: string | undefined;
  line: number;
}

export interface ParsedCall {
  /** 所在符号名；null 表示模块顶层代码 */
  callerName: string | null;
  callerContainer?: string | undefined;
  /** 被调名字的最后一段，如 `a.b.c()` 中的 `c` */
  callee: string;
  /** 接收者文本，如 `this` / `self` / `obj` / Go 的包别名 */
  receiver?: string | undefined;
  /** 完整点分路径，如 `["a","b","c"]` */
  calleePath?: string[] | undefined;
  line: number;
  argCount: number;
  kind: CallKind;
}

export interface ParsedTypeRelation {
  subject: string;
  subjectKind: SymbolKind;
  relation: "extends" | "implements" | "embeds";
  target: string;
  /** 限定路径，如 `pkg.Type` / `crate::Trait` */
  targetPath?: string[] | undefined;
  line: number;
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  imports: ParsedImport[];
  exports: ParsedExport[];
  calls: ParsedCall[];
  typeRelations: ParsedTypeRelation[];
  /** Rust `mod foo;` 声明，供模块树解析使用 */
  moduleDecls?: string[] | undefined;
  /** 解析是否遇到语法错误（不阻断，但会记录） */
  hasError: boolean;
}

// ---------------------------------------------------------------------------
// 发现阶段
// ---------------------------------------------------------------------------

export interface DiscoveredPackage {
  /** 包名，如 `@repolens/core`、`github.com/x/y/pkg`、crate 名 */
  name: string;
  /** 仓库相对目录（posix，根为 `.`） */
  dir: string;
  manager: PackageManager;
  /** package.json 的 exports/main/module/types 解析出的入口候选 */
  entryPoints: string[];
  version?: string | undefined;
}

export interface DiscoveredFile {
  /** 仓库相对路径（posix） */
  path: string;
  language: Language;
  role: FileRole;
  bytes: number;
  /** 内容哈希，增量扫描的判定依据 */
  hash: string;
  packageDir: string | null;
}

// ---------------------------------------------------------------------------
// 模块解析器契约
// ---------------------------------------------------------------------------

export interface ResolveContext {
  /** 仓库绝对根路径 */
  root: string;
  /** 发起 import 的文件（仓库相对 posix 路径） */
  fromFile: string;
  /** 仓库内全部文件路径集合，用于存在性判定 */
  hasFile: (repoRelPath: string) => boolean;
  /** 目录是否存在 */
  hasDir: (repoRelPath: string) => boolean;
  /** 已发现的包 */
  packages: readonly DiscoveredPackage[];
}

export type ResolveOutcome =
  /** 解析到仓库内文件 */
  | { status: "internal"; target: string }
  /** 解析到仓库内目录（Go 的包级 import） */
  | { status: "internal-dir"; target: string }
  /** 第三方依赖或语言内置 */
  | { status: "external"; name: string }
  /** 明确无法解析，需要在 UI 上暴露 */
  | { status: "unresolved"; reason: string };

export interface ModuleResolver {
  languages: readonly AnalyzableLanguage[];
  resolve: (specifier: string, ctx: ResolveContext) => ResolveOutcome;
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

export interface LlmConfig {
  /** OpenAI 兼容的 base URL，如 `https://api.openai.com/v1` */
  baseUrl: string;
  model: string;
  /** 环境变量名，不直接存 key */
  apiKeyEnv: string;
  maxConcurrency: number;
  temperature: number;
  /** 生成内容的语言 */
  outputLanguage: "zh" | "en";
  enabled: boolean;
}

export interface RepolensConfig {
  /** 额外忽略的 glob */
  exclude: string[];
  /** 强制纳入的 glob，优先级高于 exclude */
  include: string[];
  /** 超过此字节数的文件跳过解析 */
  maxFileBytes: number;
  /** 默认视图的节点数上限，超出则聚合 */
  maxNodesPerView: number;
  /** 默认参与图谱的文件角色 */
  defaultRoles: FileRole[];
  llm: LlmConfig;
}

// ---------------------------------------------------------------------------
// 扫描结果统计
// ---------------------------------------------------------------------------

export interface ScanStats {
  durationMs: number;
  filesDiscovered: number;
  filesParsed: number;
  filesReused: number;
  filesDeleted: number;
  symbols: number;
  imports: number;
  importsResolved: number;
  importsExternal: number;
  importsUnresolved: number;
  calls: number;
  callsByConfidence: Record<Confidence, number>;
  parseErrors: number;
  packages: number;
  loc: number;
  byLanguage: Record<string, { files: number; loc: number }>;
}

// ---------------------------------------------------------------------------
// API 传输对象 —— 前端唯一依赖的数据形状
// ---------------------------------------------------------------------------

export type GraphNodeKind = "package" | "directory" | "file" | "symbol" | "external" | "aggregate";

export interface NodeMetrics {
  loc: number;
  files: number;
  symbols: number;
  complexity: number;
  inDegree: number;
  outDegree: number;
}

export type FindingKind = "duplicate" | "cycle";
export type FindingSeverity = "high" | "medium" | "low";

export interface FindingDto {
  groupKey: string;
  kind: FindingKind;
  severity: FindingSeverity;
  scopeKind: "package" | "directory" | "file" | "symbol";
  /** 图节点 id，界面上可以直接跳过去 */
  scopeKey: string;
  path: string;
  title: string;
  detail: string;
  /** 同组的其他节点 id，可一起点亮 */
  related: string[];
  /** 该组涉及几个节点 */
  members: number;
}

export interface FindingSummaryDto {
  total: number;
  high: number;
  byKind: Record<string, number>;
}

export interface FindingQuery {
  kind?: FindingKind | undefined;
  /** 限定在某个作用域子树内，形如 `dir:packages/core` */
  scope?: string | undefined;
  limit?: number | undefined;
}

/** 挂在图节点上的体检角标 */
export interface NodeFindings {
  count: number;
  high: number;
}

export interface GraphNodeDto {
  /** 形如 `pkg:core` / `dir:src/db` / `file:42` / `sym:1337` / `external` / `agg:...` */
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** 仓库相对路径，符号节点为所在文件路径 */
  path?: string | null;
  language?: Language | null;
  role?: FileRole | null;
  symbolKind?: SymbolKind | null;
  metrics: NodeMetrics;
  /** 可下钻的子节点数量；0 表示叶子 */
  childCount: number;
  expandable: boolean;
  /** 聚合节点所折叠的真实节点 id */
  aggregatedIds?: string[] | null;
  /** 调用图的中心节点，界面上需要高亮出发点 */
  focus?: boolean | null;
  /** 体检结论计数，含子孙上卷；无问题时不带这个字段 */
  findings?: NodeFindings | null;
  /** M3：LLM 识别的架构层 */
  layer?: string | null;
  /** M3：LLM 生成的一句话摘要 */
  summary?: string | null;
}

export interface GraphEdgeDto {
  id: string;
  source: string;
  target: string;
  type: EdgeType;
  confidence: Confidence;
  /** 归一化后的强度，用于边宽 */
  weight: number;
  /** 聚合了多少条底层边 */
  count: number;
  /** ambiguous 时的候选数量 */
  candidates?: number | null;
}

export interface GraphDto {
  nodes: GraphNodeDto[];
  edges: GraphEdgeDto[];
  /** 被聚合掉的节点总数，用于「其他 N 项」提示 */
  truncated: number;
}

export interface LanguageBreakdown {
  language: Language;
  files: number;
  loc: number;
  share: number;
}

/**
 * 索引当前的总量。
 *
 * 必须和 ScanStats 分开：ScanStats 描述「最近一次扫描做了多少事」，
 * 一次增量扫描后它的 filesParsed 是 1、imports 是个位数。把它当成
 * 仓库规模展示，界面上就会写着这个仓库只有 4 个 import。
 */
export interface IndexTotals {
  files: number;
  loc: number;
  symbols: number;
  calls: number;
  imports: number;
  importsResolved: number;
  importsExternal: number;
  importsUnresolved: number;
  packages: number;
}

/** 最近一次扫描的增量信息，用于「上次扫了什么」而不是「仓库有多大」 */
export interface LastScanDto {
  durationMs: number;
  filesParsed: number;
  filesReused: number;
  filesDeleted: number;
  parseErrors: number;
}

export interface OverviewDto {
  repoName: string;
  repoRoot: string;
  scannedAt: string;
  totals: IndexTotals;
  lastScan: LastScanDto;
  languages: LanguageBreakdown[];
  packages: Array<{
    id: string;
    name: string;
    dir: string;
    manager: PackageManager;
    loc: number;
    files: number;
  }>;
  /** M3 */
  summary?: string | null;
  layers?: Array<{ name: string; description: string; nodeIds: string[] }> | null;
}

export interface TreeNodeDto {
  id: string;
  name: string;
  path: string;
  kind: "directory" | "file";
  language?: Language | null;
  role?: FileRole | null;
  loc: number;
  files: number;
  symbols: number;
  complexity: number;
  /** 相对同级最大值的热度 0-1，供热力着色 */
  heat: number;
  hasChildren: boolean;
  children?: TreeNodeDto[] | null;
}

export interface SymbolSummaryDto {
  id: string;
  name: string;
  kind: SymbolKind;
  container?: string | null;
  exported: boolean;
  signature?: string | null;
  startLine: number;
  endLine: number;
  loc: number;
  complexity: number;
  callerCount: number;
  calleeCount: number;
}

export interface FileDetailDto {
  id: string;
  path: string;
  language: Language;
  role: FileRole;
  loc: number;
  bytes: number;
  packageName?: string | null;
  parseError?: string | null;
  symbols: SymbolSummaryDto[];
  imports: Array<{
    source: string;
    kind: ImportKind;
    confidence: Confidence;
    targetPath?: string | null;
    specifiers: string[];
    line: number;
  }>;
  importedBy: Array<{ id: string; path: string }>;
  summary?: string | null;
}

export interface ParamDto {
  name: string;
  type?: string | null;
  defaultValue?: string | null;
  optional: boolean;
  variadic: boolean;
}

export interface RelationDto {
  id: string;
  name: string;
  kind: SymbolKind;
  path: string;
  line: number;
  confidence: Confidence;
  /** ambiguous 时的同名候选 */
  candidates?: Array<{ id: string; path: string }> | null;
}

export interface SymbolDetailDto {
  id: string;
  name: string;
  kind: SymbolKind;
  container?: string | null;
  filePath: string;
  fileId: string;
  language: Language;
  exported: boolean;
  signature?: string | null;
  params: ParamDto[];
  returnType?: string | null;
  doc?: string | null;
  startLine: number;
  endLine: number;
  complexity: number;
  isAsync?: boolean | null;
  receiverType?: string | null;
  callers: RelationDto[];
  callees: RelationDto[];
  /** 指向仓库外的调用，聚合展示 */
  externalCallees: Array<{ name: string; count: number }>;
  typeRelations: Array<{ relation: "extends" | "implements" | "embeds"; target: string; targetId?: string | null }>;
  /** M3，按需生成 */
  summary?: string | null;
  pseudocode?: string | null;
}

export interface SearchHitDto {
  id: string;
  kind: "file" | "symbol" | "package" | "directory";
  label: string;
  detail: string;
  score: number;
}

export interface SourceSliceDto {
  path: string;
  language: Language;
  startLine: number;
  endLine: number;
  code: string;
}

export interface PathQueryResultDto {
  found: boolean;
  hops: Array<{ node: GraphNodeDto; edge?: GraphEdgeDto | null }>;
}

// ---------------------------------------------------------------------------
// 图查询参数
// ---------------------------------------------------------------------------

export interface GraphQuery {
  /** 视图层级 */
  level: "package" | "directory" | "file" | "symbol";
  /** 以此节点为作用域；缺省为整仓 */
  scope?: string | undefined;
  /** 以此节点为中心的邻居层数 */
  focus?: string | undefined;
  depth?: number | undefined;
  /** 允许的置信度档位 */
  confidence?: Confidence[] | undefined;
  /** 允许的文件角色 */
  roles?: FileRole[] | undefined;
  /** 节点数上限，超出则聚合 */
  limit?: number | undefined;
  /** 是否包含 external 聚合节点 */
  includeExternal?: boolean | undefined;
  edgeTypes?: EdgeType[] | undefined;
}

/** 以单个符号为中心的调用图查询 */
export interface CallGraphOptions {
  symbolId: number;
  /** 上下游各展开几跳，1-4 */
  depth?: number | undefined;
  direction?: "callers" | "callees" | "both" | undefined;
  /** 每个节点每层最多取多少条边，防止热点函数拉爆图 */
  limit?: number | undefined;
  confidence?: Confidence[] | undefined;
}
