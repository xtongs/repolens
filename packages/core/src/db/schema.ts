/**
 * SQLite schema。
 *
 * 以 TS 字符串而非 .sql 文件存放，是为了避免构建时额外的资源拷贝步骤——
 * tsc 不会把 .sql 带进 dist，加个拷贝脚本不如把它内联在这里。
 */

export const SCHEMA_SQL = String.raw`
-- RepoLens 知识图谱 schema
--
-- 设计要点：
-- 1. 结构事实（files/symbols/imports）与语义产物（summaries）分表，前者可重算，后者是缓存。
-- 2. 所有边统一进 edges 表，带 confidence 字段，查询时按置信度过滤。
-- 3. 目录级/包级聚合边预先算好落在 rollup_edges，避免前端每次展开都做实时聚合。

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- ---------------------------------------------------------------------------
-- 结构实体
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS packages (
  id           INTEGER PRIMARY KEY,
  name         TEXT NOT NULL,
  dir          TEXT NOT NULL UNIQUE,
  manager      TEXT NOT NULL,
  version      TEXT,
  entry_points TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS directories (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  parent_path TEXT,
  name        TEXT NOT NULL,
  depth       INTEGER NOT NULL,
  package_id  INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  -- 以下为子树累计值，由 rollup 阶段回填
  loc         INTEGER NOT NULL DEFAULT 0,
  file_count  INTEGER NOT NULL DEFAULT 0,
  symbol_count INTEGER NOT NULL DEFAULT 0,
  complexity  INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_dir_parent ON directories(parent_path);

CREATE TABLE IF NOT EXISTS files (
  id          INTEGER PRIMARY KEY,
  path        TEXT NOT NULL UNIQUE,
  dir_path    TEXT NOT NULL,
  name        TEXT NOT NULL,
  language    TEXT NOT NULL,
  role        TEXT NOT NULL,
  package_id  INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  loc         INTEGER NOT NULL DEFAULT 0,
  bytes       INTEGER NOT NULL DEFAULT 0,
  complexity  INTEGER NOT NULL DEFAULT 0,
  hash        TEXT NOT NULL,
  parsed      INTEGER NOT NULL DEFAULT 0,
  parse_error TEXT,
  -- M4：入口标记，逗号分隔的入口类型
  entry_kind  TEXT
);

CREATE INDEX IF NOT EXISTS idx_file_dir ON files(dir_path);
CREATE INDEX IF NOT EXISTS idx_file_pkg ON files(package_id);
CREATE INDEX IF NOT EXISTS idx_file_role ON files(role);
CREATE INDEX IF NOT EXISTS idx_file_lang ON files(language);

CREATE TABLE IF NOT EXISTS symbols (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL,
  container     TEXT,
  exported      INTEGER NOT NULL DEFAULT 0,
  signature     TEXT,
  params        TEXT,          -- JSON: ParamDto[]
  return_type   TEXT,
  doc           TEXT,
  start_line    INTEGER NOT NULL,
  end_line      INTEGER NOT NULL,
  start_byte    INTEGER NOT NULL,
  end_byte      INTEGER NOT NULL,
  complexity    INTEGER NOT NULL DEFAULT 1,
  is_async      INTEGER NOT NULL DEFAULT 0,
  is_static     INTEGER NOT NULL DEFAULT 0,
  receiver_type TEXT,
  /** 符号内容指纹，LLM 缓存失效判定用 */
  hash          TEXT NOT NULL DEFAULT '',
  /** 结构指纹：忽略名字与字面量的 AST 形状，用于识别重复实现 */
  shape         TEXT
);

CREATE INDEX IF NOT EXISTS idx_sym_file ON symbols(file_id);
CREATE INDEX IF NOT EXISTS idx_sym_name ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_sym_shape ON symbols(shape);
CREATE INDEX IF NOT EXISTS idx_sym_exported ON symbols(exported);
CREATE INDEX IF NOT EXISTS idx_sym_lookup ON symbols(name, kind);

-- ---------------------------------------------------------------------------
-- import / 模块解析
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS imports (
  id            INTEGER PRIMARY KEY,
  file_id       INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  raw_source    TEXT NOT NULL,
  kind          TEXT NOT NULL,
  confidence    TEXT NOT NULL,       -- exact | external | unresolved
  target_file_id INTEGER REFERENCES files(id) ON DELETE SET NULL,
  target_dir    TEXT,                -- Go 包级 import 落在目录
  external_name TEXT,
  unresolved_reason TEXT,
  is_type_only  INTEGER NOT NULL DEFAULT 0,
  line          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_imp_file ON imports(file_id);
CREATE INDEX IF NOT EXISTS idx_imp_target ON imports(target_file_id);

CREATE TABLE IF NOT EXISTS import_specifiers (
  id           INTEGER PRIMARY KEY,
  import_id    INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  imported     TEXT NOT NULL,
  local        TEXT NOT NULL,
  is_default   INTEGER NOT NULL DEFAULT 0,
  is_namespace INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_impspec_import ON import_specifiers(import_id);
CREATE INDEX IF NOT EXISTS idx_impspec_local ON import_specifiers(local);

CREATE TABLE IF NOT EXISTS exports (
  id        INTEGER PRIMARY KEY,
  file_id   INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,
  source    TEXT,
  symbol_id INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  line      INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_exp_file ON exports(file_id);
CREATE INDEX IF NOT EXISTS idx_exp_name ON exports(name);

-- ---------------------------------------------------------------------------
-- 调用点（原始事实）
-- ---------------------------------------------------------------------------

-- 与 edges 分表存放，因为二者性质不同：call_sites 是 AST 里读出来的原始事实，
-- edges 是链接后的派生结果。分开之后重跑链接器不需要重新解析源码，
-- 增量扫描只要替换变更文件的 call_sites，再整体重算一遍链接即可。
CREATE TABLE IF NOT EXISTS call_sites (
  id               INTEGER PRIMARY KEY,
  file_id          INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  caller_symbol_id INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  callee_name      TEXT NOT NULL,
  receiver         TEXT,
  callee_path      TEXT,
  call_kind        TEXT NOT NULL,
  arg_count        INTEGER NOT NULL DEFAULT 0,
  line             INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_callsite_file ON call_sites(file_id);
CREATE INDEX IF NOT EXISTS idx_callsite_caller ON call_sites(caller_symbol_id);
CREATE INDEX IF NOT EXISTS idx_callsite_name ON call_sites(callee_name);

-- ---------------------------------------------------------------------------
-- 边
-- ---------------------------------------------------------------------------

-- 符号级与文件级的原始边。src/dst 以 kind + id 二元组表达，
-- 用两列而不是多态外键，换来一张表统一查询的便利。
CREATE TABLE IF NOT EXISTS edges (
  id           INTEGER PRIMARY KEY,
  type         TEXT NOT NULL,
  src_kind     TEXT NOT NULL,       -- file | symbol
  src_id       INTEGER NOT NULL,
  dst_kind     TEXT NOT NULL,       -- file | symbol | external
  dst_id       INTEGER,
  dst_name     TEXT,                -- dst_kind = external 时的名字
  confidence   TEXT NOT NULL,
  line         INTEGER,
  call_kind    TEXT,
  /** ambiguous 时的候选符号 id，JSON 数组 */
  candidates   TEXT,
  weight       REAL NOT NULL DEFAULT 1.0
);

CREATE INDEX IF NOT EXISTS idx_edge_src ON edges(src_kind, src_id, type);
CREATE INDEX IF NOT EXISTS idx_edge_dst ON edges(dst_kind, dst_id, type);
CREATE INDEX IF NOT EXISTS idx_edge_type_conf ON edges(type, confidence);

-- 预聚合的高层边：目录→目录、包→包。
CREATE TABLE IF NOT EXISTS rollup_edges (
  id         INTEGER PRIMARY KEY,
  level      TEXT NOT NULL,          -- package | directory
  type       TEXT NOT NULL,
  src        TEXT NOT NULL,          -- 包名或目录路径
  dst        TEXT NOT NULL,
  confidence TEXT NOT NULL,
  count      INTEGER NOT NULL DEFAULT 1,
  weight     REAL NOT NULL DEFAULT 1.0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rollup_uniq
  ON rollup_edges(level, type, src, dst, confidence);
CREATE INDEX IF NOT EXISTS idx_rollup_level ON rollup_edges(level, type);

-- ---------------------------------------------------------------------------
-- 类型关系（extends / implements / embeds）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS type_relations (
  id          INTEGER PRIMARY KEY,
  file_id     INTEGER NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  subject_id  INTEGER REFERENCES symbols(id) ON DELETE CASCADE,
  subject     TEXT NOT NULL,
  relation    TEXT NOT NULL,
  target      TEXT NOT NULL,
  target_id   INTEGER REFERENCES symbols(id) ON DELETE SET NULL,
  confidence  TEXT NOT NULL,
  line        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_typerel_subject ON type_relations(subject_id);
CREATE INDEX IF NOT EXISTS idx_typerel_target ON type_relations(target_id);

-- ---------------------------------------------------------------------------
-- 架构体检
-- ---------------------------------------------------------------------------

-- 结论存表而不是查询时现算：判据里有跨全仓的比较（同形状符号分组、
-- 环检测），实时算会让每次展开都扫全表。而它和 edges 一样是纯派生数据，
-- 每次链接阶段整体重建。
--
-- 一条 finding 挂在一个「作用域」上（包/目录/文件/符号），这样图上任何
-- 一层都能直接问「我这里有没有问题」，不必反向遍历。
CREATE TABLE IF NOT EXISTS findings (
  id          INTEGER PRIMARY KEY,
  kind        TEXT NOT NULL,        -- duplicate | cycle
  severity    TEXT NOT NULL,        -- high | medium | low
  scope_kind  TEXT NOT NULL,        -- package | directory | file | symbol
  /** 图节点 id，形如 pkg:core / dir:src/db / sym:1337，便于直接和图对齐 */
  scope_key   TEXT NOT NULL,
  /** 仓库相对路径。上层节点靠它做前缀汇总，否则问题只在最深一层可见 */
  path        TEXT NOT NULL DEFAULT '',
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  /** 相关节点 id，JSON 数组；界面上可以一键把它们一起点亮 */
  related     TEXT NOT NULL DEFAULT '[]',
  /** 同一组问题共享的分组键，用于把一条 finding 的各个成员串起来 */
  group_key   TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_finding_scope ON findings(scope_kind, scope_key);
CREATE INDEX IF NOT EXISTS idx_finding_kind ON findings(kind, severity);
CREATE INDEX IF NOT EXISTS idx_finding_group ON findings(group_key);
CREATE INDEX IF NOT EXISTS idx_finding_path ON findings(path);

-- ---------------------------------------------------------------------------
-- 语义层缓存（M3）
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS summaries (
  id          INTEGER PRIMARY KEY,
  target_kind TEXT NOT NULL,        -- repo | package | directory | file | symbol
  target_key  TEXT NOT NULL,        -- 稳定键：包名 / 目录路径 / 文件路径 / 符号签名键
  flavor      TEXT NOT NULL,        -- summary | pseudocode | layer
  lang        TEXT NOT NULL,
  content     TEXT NOT NULL,
  /** 生成时目标的内容指纹，不匹配则视为过期 */
  source_hash TEXT NOT NULL,
  model       TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_summary_uniq
  ON summaries(target_kind, target_key, flavor, lang);

CREATE TABLE IF NOT EXISTS layers (
  id          INTEGER PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  ordinal     INTEGER NOT NULL DEFAULT 0,
  members     TEXT NOT NULL DEFAULT '[]',  -- JSON: 节点 id 数组
  source_hash TEXT NOT NULL DEFAULT '',
  model       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT ''
);

-- ---------------------------------------------------------------------------
-- 全文搜索
-- ---------------------------------------------------------------------------

-- role 冗余在这里而不是查询时回表：搜索要按噪音开关过滤，而 FTS5
-- 的 MATCH 必须先跑完才能拿到行，回表 JOIN 会让 LIMIT 失去意义
-- （先取 30 条再过滤掉 25 条测试文件，结果只剩 5 条）。
CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
  label,
  detail,
  kind UNINDEXED,
  ref  UNINDEXED,
  role UNINDEXED,
  tokenize = 'unicode61'
);
`;

/** schema 版本，变更时 bump，旧库会被重建 */
export const SCHEMA_VERSION = "4";
