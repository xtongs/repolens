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

export type BuiltinLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "vue"
  | "svelte"
  | "astro"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "kotlin"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "ruby"
  | "powershell"
  | "swift"
  | "dart"
  | "lua"
  | "scala"
  | "elixir"
  | "erlang"
  | "haskell"
  | "clojure"
  | "objective-c"
  | "groovy"
  | "perl"
  | "r"
  | "zig"
  | "nim"
  | "solidity"
  | "sql"
  | "html"
  | "css"
  | "scss"
  | "less"
  | "graphql"
  | "protobuf"
  | "terraform"
  | "json"
  | "yaml"
  | "toml"
  | "markdown"
  | "shell"
  | "other";

/** 第三方注册语言使用命名空间，避免与后续内置语言重名。 */
export type Language = BuiltinLanguage | `custom:${string}`;

/** 参与 AST 图谱构建的语言（有 grammar 与抽取器，或可提取内嵌脚本）。 */
export type AnalyzableLanguage =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "vue"
  | "svelte"
  | "astro"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "c"
  | "cpp"
  | "csharp"
  | "php"
  | "ruby"
  | "powershell"
  | "shell"
  | "css"
  | `custom:${string}`;

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
  | "references"
  /** 前端请求按 URL 对上后端路由：没有 import，靠字面量推断，始终是 likely */
  | "http";

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

/** render：JSX 元素 `<Comp/>`，语义上是对组件函数的调用 */
export type CallKind = "call" | "method" | "new" | "macro" | "render";

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
  /** 导出名背后的本地声明名：`export default foo`、`export { foo as bar }` */
  local?: string | undefined;
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
  /**
   * 接收者的类型线索，链接阶段解析：`T:类型` 来自标注、`new`、`as`；
   * `R:路径` 表示接收者是那个函数的返回值，`A:路径` 是 await 过的返回值；
   * `M:线索` 是属性链 `c.req`，线索属于根变量；`C:方法|线索` 是没标类型的回调参数，
   * 由线索所指对象的那个方法传进来。`P:` 是看不出类型的参数，`D:路径` 是从那次调用的返回值里解构出来的，
   * 这两种只给走读界面解释用。裸调用记的是被调名本身的线索
   */
  receiverType?: string | undefined;
  /** 完整点分路径，如 `["a","b","c"]` */
  calleePath?: string[] | undefined;
  line: number;
  /** 调用表达式结束的字节偏移；同一行里的嵌套调用靠它排出求值先后 */
  endByte: number;
  /** 被调名本身的位置（列为 UTF-16 偏移），单步走读据此高亮 */
  nameLine: number;
  nameColumn: number;
  argCount: number;
  /** 前几个实参的源码文本；用于入口识别和单步走读的实参展示，不做求值。 */
  argumentTexts?: string[] | undefined;
  kind: CallKind;
}

/** 框架注册语法中可由 AST 直接证明的入口提示。 */
export interface ParsedEntryHint {
  kind: "http" | "cli";
  framework: string;
  /** 注册的处理函数名；匿名闭包无法静态命名时为空。 */
  handlerName?: string | undefined;
  line: number;
  label: string;
  method?: string | undefined;
  route?: string | undefined;
  confidence: "exact" | "likely";
  evidence: string;
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
  entryHints?: ParsedEntryHint[] | undefined;
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
  /** 文件/函数按需生成可选用更快的模型；null 表示沿用 model */
  interactiveModel: string | null;
  /** 环境变量名，不直接存 key */
  apiKeyEnv: string;
  maxConcurrency: number;
  temperature: number;
  /** 支持该 OpenAI 扩展字段的模型可用；不支持时可设为 null */
  reasoningEffort: "low" | "medium" | "high" | null;
  /** 单次生成最多返回多少 token */
  maxOutputTokens: number;
  /** 单次 HTTP 请求超时；本地模型也不能无限挂住扫描 */
  requestTimeoutMs: number;
  /** 429 / 5xx / 网络错误的重试次数 */
  maxRetries: number;
  /** 扫描期一个请求批量生成多少个包/目录摘要 */
  scanBatchSize: number;
  /** 扫描期最多调用模型多少次，防止超大仓库意外烧穿预算 */
  scanMaxCalls: number;
  /** 生成内容的语言 */
  outputLanguage: "zh" | "en";
  enabled: boolean;
  /** 追问时让模型按需读文件、搜代码、看 git 历史；模型或网关不支持函数调用时自动退回 */
  chatTools: boolean;
  /** 追问时允许模型抓取公开网页；只能在用户级配置里打开 */
  webFetch: boolean;
}

export interface RepolensConfig {
  /** 额外忽略的 glob */
  exclude: string[];
  /** 强制纳入的 glob，优先级高于 exclude */
  include: string[];
  /** 路径 glob → 文件角色；显式覆盖内置启发式规则。 */
  roleOverrides: Record<string, FileRole>;
  /** 超过此字节数的文件跳过解析 */
  maxFileBytes: number;
  /** 默认视图的节点数上限，超出则聚合 */
  maxNodesPerView: number;
  /** 默认参与图谱的文件角色 */
  defaultRoles: FileRole[];
  /** 仓库声明的依赖禁令，违反的 import 进体检 */
  rules: ArchitectureRule[];
  llm: LlmConfig;
}

/**
 * 一条依赖禁令：`from` 里的源码文件不许 import `disallow` 命中的目标。
 * 目标既可以是仓库内路径 glob，也可以是外部包名（`electron`、`node:fs`、`@nestjs/*`）。
 */
export interface ArchitectureRule {
  /** 体检标题里的简称；缺省为「from ↛ disallow」 */
  name: string | null;
  from: string[];
  disallow: string[];
  /** 命中 disallow 但仍放行的例外 */
  allow: string[];
  /** 纯类型 import 默认不算违规：共享 DTO 类型不构成运行时耦合 */
  includeTypeOnly: boolean;
  severity: FindingSeverity;
  /** 为什么有这条规则，显示在体检详情里 */
  reason: string | null;
}

// ---------------------------------------------------------------------------
// 扫描结果统计
// ---------------------------------------------------------------------------

/** 前端请求按 URL 推断到后端路由的连线 */
export interface HttpLinkStats {
  /** 代码里注册的后端路由数；为 0 时不做匹配 */
  routes: number;
  /** 连上的「调用方 → 路由」对，含多义的 */
  linked: number;
  ambiguous: number;
}

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
  /** 旧版本写进索引的 stats 没有这一项 */
  http?: HttpLinkStats | undefined;
  parseErrors: number;
  packages: number;
  loc: number;
  byLanguage: Record<string, { files: number; loc: number }>;
  /** M3；LLM 不可用时仍返回状态，结构扫描绝不因此失败 */
  llm?: LlmRunStats | undefined;
}

export interface LlmUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface LlmRunStats extends LlmUsage {
  enabled: boolean;
  available: boolean;
  model: string;
  generated: number;
  cacheHits: number;
  failures: number;
  durationMs: number;
  reason?: string | undefined;
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

export type FindingKind = "duplicate" | "cycle" | "violation" | "oversized";
export const FINDING_KINDS: readonly FindingKind[] = ["duplicate", "cycle", "violation", "oversized"];
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
  /** 限定在某个图节点里：`pkg:` / `dir:` 取子树，`file:` 含文件里的符号，`sym:` 只取它自己 */
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
  /** 仓库概览缺失时，上次扫描记录的具体原因。 */
  summaryUnavailableReason?: string | null;
  layers?: Array<{ name: string; description: string; nodeIds: string[] }> | null;
  llm?: LlmStatusDto | null;
}

export interface LlmStatusDto {
  enabled: boolean;
  available: boolean;
  model: string;
  interactiveModel?: string | null;
  reason?: string | null;
  usage: LlmUsage;
}

// ---------------------------------------------------------------------------
// 仓库清单
// ---------------------------------------------------------------------------

/**
 * `ok` 之外的两档都是「清单里有、但现在用不了」：索引被删了，或者仓库
 * 整个被移走了。界面要能把它们灰掉并说明原因，而不是让人点进去撞个报错。
 */
export type RepoStatus = "ok" | "index-missing" | "root-missing";

export interface RegisteredRepo {
  /** 绝对路径的短哈希，URL 安全且定长 */
  id: string;
  root: string;
  name: string;
  /** ISO 时间戳，用于排序与淘汰 */
  lastOpenedAt: string;
}

export interface RepoEntry extends RegisteredRepo {
  status: RepoStatus;
  /** 当前 Git 分支；detached HEAD 显示为 detached@短提交，非 Git 仓库为 null。 */
  branch: string | null;
}

export interface ReposDto {
  /** 启动时指定的那个仓库，缺省请求都落到它；桌面端不指定时为 null */
  current: string | null;
  repos: RepoEntry[];
}

// ---------------------------------------------------------------------------
// 仓库扫描任务
// ---------------------------------------------------------------------------

/** 扫描流水线阶段；CLI、服务端任务和前端进度提示共用同一组值。 */
export type ScanPhase =
  | "discover"
  | "parse"
  | "resolve"
  | "link"
  | "rollup"
  | "enrich"
  | "index";

export type RepoScanStatus = "running" | "completed" | "failed";

/** Web 端可轮询的扫描任务快照。progress 的范围是 0..1。 */
export interface RepoScanTaskDto {
  id: string;
  root: string;
  name: string;
  status: RepoScanStatus;
  phase: ScanPhase | null;
  done: number;
  total: number;
  progress: number;
  startedAt: string;
  completedAt: string | null;
  error: string | null;
  repo: RepoEntry | null;
}

export interface PickRepoResultDto {
  cancelled: boolean;
  task?: RepoScanTaskDto;
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
  /**
   * 按磁盘列出的结构树才有：analyzed 参与分析；noise 进了索引但按角色不上主干图
   * （测试、配置、文档等，文件的角色见 role）；excluded 没进索引，原因见 excludedBy。
   */
  status?: "analyzed" | "noise" | "excluded";
  excludedBy?: ExclusionReason | null;
}

/** 文件或目录没进索引的原因，判定规则和扫描时的遍历一致 */
export type ExclusionReason =
  /** node_modules、.venv、target 这类固定跳过的依赖和构建目录 */
  | "builtin"
  /** .gitignore、.repolensignore 或配置里的 exclude */
  | "ignored"
  | "vendor"
  /** 超过配置的 maxFileBytes */
  | "too-large"
  /** 软链接不跟随，避免成环或指到仓库外 */
  | "symlink"
  /** 上次扫描之后才出现 */
  | "unscanned";

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
  shortSummary?: string | null;
  pseudocode?: string | null;
  pseudocodeSteps?: PseudocodeStepDto[] | null;
}

/**
 * 伪代码中的一步。`lines` 是模型标注的源码闭区间，已按所属符号或文件的
 * 行范围校验过；它仍是 AI 推断，不是解析器给出的事实。旧缓存没有这份
 * 对应关系，此时 `lines` 为空。
 */
export interface PseudocodeStepDto {
  text: string;
  lines?: [number, number] | null;
  children: PseudocodeStepDto[];
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
  /** 对方符号所在文件 */
  path: string;
  /** 调用发生的行，在调用方的文件里 */
  line: number;
  /** 对方符号的定义行，在 path 里 */
  definedAt: number;
  confidence: Confidence;
  /** ambiguous 时的同名候选 */
  candidates?: Array<{ id: string; path: string }> | null;
  /** 关系来自 JSX `<Comp/>` 而非函数调用 */
  rendered?: boolean;
  /** 关系来自前端请求按 URL 对上的后端路由，没有 import 证据 */
  http?: boolean;
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
  shortSummary?: string | null;
  pseudocode?: string | null;
  pseudocodeSteps?: PseudocodeStepDto[] | null;
}

/** 文件/符号按需生成接口的统一返回形状。 */
export interface SemanticResultDto {
  summary: string | null;
  shortSummary?: string | null;
  pseudocode?: string | null;
  pseudocodeSteps?: PseudocodeStepDto[] | null;
  /** 没有可供模型理解的内容时直接跳过，不发起 LLM 请求。 */
  skipReason?: "empty-file" | null;
  generated: boolean;
  cacheHit: boolean;
  model: string;
  usage: LlmUsage;
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

/** 包 / 目录里作者自己写的说明，原文交给界面渲染 */
export interface ReadmeDto {
  /** README 自己的文件节点 */
  fileId: string;
  path: string;
  /** rst、txt 和无扩展名的按纯文本显示，不当 markdown 解析 */
  format: "markdown" | "text";
  content: string;
  /** 超过读取上限，只给了开头一段 */
  truncated: boolean;
}

export interface PathQueryResultDto {
  found: boolean;
  hops: Array<{ node: GraphNodeDto; edge?: GraphEdgeDto | null }>;
}

// ---------------------------------------------------------------------------
// 入口与单步走读
// ---------------------------------------------------------------------------

export type EntryPointKind = "main" | "cli" | "http" | "public-api" | "test";
/** 调用点上认出的 I/O 访问 */
export type IoKind = "database" | "network" | "filesystem" | "message-queue" | "process";

export interface EntryPointDto {
  id: string;
  kind: EntryPointKind;
  framework?: string | null;
  /** 处理函数；匿名闭包没有独立符号时为空，这样的入口无法走读 */
  symbolId?: string | null;
  fileId: string;
  filePath: string;
  fileRole: FileRole;
  line: number;
  label: string;
  method?: string | null;
  route?: string | null;
  confidence: "exact" | "likely";
  evidence: string;
  /** 从处理函数往下沿确定/可能的调用能走到的仓库内函数数（封顶 999） */
  reachSymbols: number;
  /** 上面那些函数分布在几个别的文件里，不含处理函数自己所在的文件 */
  reachFiles: number;
  /** 往下会碰到的 I/O 类型 */
  reachIo: IoKind[];
}

/** 某个函数往下最少几跳会碰到某类 I/O；0 表示它自己就在做 */
export interface IoReachDto {
  kind: IoKind;
  depth: number;
}

/** 走读里一次调用指向的仓库内函数 */
export interface WalkTargetDto {
  id: string;
  /** 带容器的全名，如 `IndexWriter.upsertFile` */
  name: string;
  kind: SymbolKind;
  fileId: string;
  filePath: string;
  line: number;
  /** 它的函数体里还有几处可以继续走的调用；0 说明步入后就到底了 */
  steps: number;
  /** 已缓存的 AI 一句话摘要；只读缓存，不为走读触发生成 */
  summary?: string | null;
  reaches: IoReachDto[];
}

/** 函数体里的一处调用，按执行顺序排在 WalkFrameDto.calls 里 */
export interface WalkCallDto {
  id: string;
  /** 被调名所在行；跨行的链式调用里各段落在各自的行上 */
  line: number;
  /** 被调名在该行的起始列（UTF-16 偏移），界面据此高亮到具体位置 */
  column: number;
  callee: string;
  receiver?: string | null;
  kind: CallKind;
  arguments: string[];
  resolution: Confidence;
  /** exact / likely 时的落点；ambiguous 时是候选里的第一个，以 candidates 为准 */
  target?: WalkTargetDto | null;
  candidates?: WalkTargetDto[] | null;
  /** external 时的库名 */
  external?: string | null;
  /** external 落在语言内置（Map、console、len）上，而不是哪个文件 import 过的库 */
  builtin?: boolean;
  /** unresolved 时推不出来的原因，界面据此给出具体提示 */
  unresolved?: UnresolvedReason | null;
  io?: IoKind | null;
}

/**
 * 调用为什么没解析出来：
 * callback 是参数传进来的函数；function-value 是变量里存的函数，source 是产生它的调用（如 `useT()`），
 * destructured 表示是从那次调用的返回值里解构出来的（如 `useState()`）；
 * chained 接在推不出类型的返回值上；untyped 是接收者变量推不出类型，source 是给它赋值的调用，
 * param 表示它是没标类型的参数；inherited 是 this 上的方法在类和父类里都没找到。
 */
export type UnresolvedReason =
  | { kind: "callback" }
  | { kind: "function-value"; source: string | null; destructured?: boolean }
  | { kind: "chained" }
  | { kind: "untyped"; source?: string; param?: boolean }
  | { kind: "inherited" };

/** 单步走读的一帧：一个函数的源码范围，以及它体内依次发生的调用 */
export interface WalkFrameDto {
  id: string;
  name: string;
  kind: SymbolKind;
  fileId: string;
  filePath: string;
  language: Language;
  startLine: number;
  endLine: number;
  signature?: string | null;
  summary?: string | null;
  reaches: IoReachDto[];
  calls: WalkCallDto[];
}

// ---------------------------------------------------------------------------
// 变更视角：两份索引之间的结构差异
// ---------------------------------------------------------------------------

export type ChangeStatus = "added" | "removed" | "modified";

export interface FileChangeDto {
  status: ChangeStatus | "moved";
  path: string;
  /** moved 时的旧路径 */
  from?: string | null;
  /** head 里的文件节点 id；removed 时为 null */
  id: string | null;
  role: FileRole;
  language: Language;
  loc: number;
  locBefore: number;
}

export interface SymbolChangeDto {
  status: ChangeStatus;
  /** head 里的符号节点 id；removed 时为 null */
  id: string | null;
  name: string;
  container: string | null;
  kind: SymbolKind;
  path: string;
  line: number;
  exported: boolean;
  role: FileRole;
  complexity: number;
  complexityBefore: number | null;
  signature: string | null;
  signatureBefore: string | null;
  /** modified 时 AST 形状是否变了；false 说明只动了命名、字面量或格式 */
  shapeChanged: boolean;
  /** 直接调用方数量：removed 取基线里的，其余取当前的 */
  callers: number;
}

export interface DependencyChangeDto {
  status: "added" | "removed";
  level: "package" | "directory";
  source: string;
  target: string;
  type: "imports" | "references" | "http";
  count: number;
}

export interface FindingChangeDto {
  status: "added" | "resolved";
  kind: FindingKind;
  severity: FindingSeverity;
  title: string;
  detail: string;
  scopeKey: string;
  path: string;
}

export interface EntryChangeDto {
  /** affected：入口本身还在，但它能走到的代码变了 */
  status: "added" | "removed" | "affected";
  /** head 里的入口 id；removed 时为 null */
  id: string | null;
  /** head 里入口对应的处理函数 */
  symbolId: string | null;
  kind: EntryPointKind;
  label: string;
  path: string;
  /** 从入口出发能走到的已变更符号，按调用深度排序 */
  via: Array<{ id: string; name: string; depth: number }>;
}

/** 变更对比可以挑的基线提交，只列动过扫描根的 */
export interface CommitDto {
  commit: string;
  short: string;
  subject: string;
  author: string;
  /** 提交时间，ISO 格式 */
  date: string;
  /** 当前检出的就是它 */
  head: boolean;
  branches: string[];
  tags: string[];
}

export interface ChangeReportDto {
  base: { ref: string; commit: string };
  /** head 为 null 表示工作区（含未提交改动） */
  head: { ref: string; commit: string } | null;
  /** 对比用的当前索引是什么时候扫描的：工作区对比只反映那一刻的代码 */
  headIndexedAt: string | null;
  generatedAt: string;
  files: FileChangeDto[];
  symbols: SymbolChangeDto[];
  dependencies: DependencyChangeDto[];
  externals: { added: string[]; removed: string[] };
  findings: FindingChangeDto[];
  entries: EntryChangeDto[];
}

// ---------------------------------------------------------------------------
// 追问 AI
// ---------------------------------------------------------------------------

/**
 * 一条追问附带的上下文。浏览器只传节点 id 和用户引用的文字，源码、调用
 * 关系、摘要都由服务端按 id 现查——既不让前端把整段源码塞进请求，也不
 * 让模型看到一份可能被篡改过的「源码」。
 */
export type ChatRefDto =
  | { kind: "node"; id: string }
  | {
      kind: "quote";
      text: string;
      /** 引用出自哪个节点；带行号时服务端会附上那几行原文 */
      nodeId?: string | null;
      lines?: [number, number] | null;
    }
  | {
      kind: "view";
      mode: "structure" | "callgraph" | "walk";
      /** 结构视图的根作用域，或调用图的 `call:<symbolId>` */
      scope?: string | null;
      expanded?: string[] | null;
      /** 单步走读的调用栈，自入口起；每帧是函数 id 和停在哪处调用上 */
      walk?: Array<{ id: string; at: string | null }> | null;
    };

export interface ChatMessageDto {
  role: "user" | "assistant";
  content: string;
  refs?: ChatRefDto[] | null;
}

export interface ChatRequestDto {
  messages: ChatMessageDto[];
}

/** 服务端实际放进提示词的上下文，回显给界面，让人知道 AI 看到了什么。 */
export interface ChatContextItemDto {
  label: string;
  detail: string;
  nodeId?: string | null;
}

/**
 * 回答过程中模型自己去查的一步（读文件、搜代码、看提交、抓网页）。同一个 id 先以
 * running 推一次，完成后再推一次最终状态，界面据此原地更新。
 */
export interface ChatToolStepDto {
  id: string;
  tool: ChatToolName;
  /** 给人看的对象：路径、搜索词、提交号或网址 */
  target: string;
  status: "running" | "done" | "error";
  /** 能在界面上打开的节点；没进索引的文件是 `raw:路径` */
  nodeId?: string | null;
  lines?: [number, number] | null;
  url?: string | null;
  error?: string | null;
}

export type ChatToolName =
  | "list_files"
  | "read_file"
  | "search_code"
  | "find_symbols"
  | "get_node"
  | "git_log"
  | "git_show"
  | "git_blame"
  | "git_diff"
  | "fetch_url";

export interface ChatDoneDto {
  model: string;
  usage: LlmUsage;
}

// ---------------------------------------------------------------------------
// 笔记
// ---------------------------------------------------------------------------

/**
 * 笔记挂在哪儿。节点 id 每次扫描都会变，所以文件和符号存路径与行号，
 * 包和目录的 id 本身就由名字、路径组成，可以原样保存。
 */
export type NoteTargetDto =
  | {
      kind: "file";
      path: string;
      lines: [number, number] | null;
      /** 从符号记下时的符号名，界面用它说明这几行是什么 */
      symbol: string | null;
    }
  | { kind: "scope"; id: string; label: string };

export interface NoteDto {
  id: string;
  target: NoteTargetDto;
  text: string;
  /** 记笔记时对应的那个追问 */
  question: string | null;
  createdAt: string;
  /** 当前索引里对应的节点；文件已删除或改名时为 null */
  nodeId: string | null;
  /** 文件在记笔记之后改过，行号可能已经对不上 */
  stale: boolean;
}

export interface NoteInputDto {
  /** 当前索引里的节点 id，服务端据此换算成稳定的路径和行号 */
  nodeId: string;
  lines?: [number, number] | null;
  text: string;
  question?: string | null;
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
