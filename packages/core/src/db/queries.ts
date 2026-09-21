import { readFileSync } from "node:fs";
import { join } from "node:path";
import { baseName, depthOf, dirOf, isWithin } from "../resolve/path-utils.js";
import type {
  CallGraphOptions,
  Confidence,
  FileDetailDto,
  FileRole,
  FindingDto,
  FindingKind,
  FindingQuery,
  FindingSeverity,
  FindingSummaryDto,
  GraphDto,
  GraphEdgeDto,
  GraphNodeDto,
  ImportKind,
  IndexTotals,
  Language,
  LanguageBreakdown,
  NodeMetrics,
  OverviewDto,
  ParamDto,
  RelationDto,
  ScanStats,
  SearchHitDto,
  SourceSliceDto,
  SymbolDetailDto,
  SymbolKind,
  SymbolSummaryDto,
  TreeNodeDto,
  LlmStatusDto,
} from "../types.js";
import { getMeta, getMetaJson, type Db } from "./database.js";
import { readLlmStatus, semanticLanguage } from "../llm/cache.js";
import { normalizeSemanticContent, type SemanticTextFlavor } from "../llm/format.js";

export const EXTERNAL_NODE_ID = "external";

/** 仓库根作用域的 id。包级视图和顶层目录视图都挂在这里。 */
export const ROOT_SCOPE = "dir:.";

export interface GraphOptions {
  /** 作用域节点 id；缺省为仓库根 */
  scope?: string | undefined;
  /** 节点数上限，超出的按主指标折叠成聚合节点 */
  limit?: number | undefined;
  roles?: FileRole[] | undefined;
  confidence?: Confidence[] | undefined;
  includeExternal?: boolean | undefined;
  /**
   * 这个节点必须出现在结果里，不允许被折叠。
   *
   * 给「跳转到某个具体节点」用：不锁住的话，搜索或体检清单点进来的目标
   * 常常正好是体量小的那个，一折叠就进了「其他 N 项」，图上根本看不到它，
   * 导航等于只走了一半。
   */
  keep?: string | undefined;
}

const DEFAULT_ROLES: FileRole[] = ["source"];
const DEFAULT_CONFIDENCE: Confidence[] = ["exact", "likely"];

// ---------------------------------------------------------------------------
// 总览
// ---------------------------------------------------------------------------

export function getOverview(db: Db): OverviewDto {
  const lastRun = getMetaJson<ScanStats>(db, "stats", {} as ScanStats);
  const totals = getIndexTotals(db);
  const totalLoc = Math.max(totals.loc, 1);

  const languages: LanguageBreakdown[] = (
    db
      .prepare(
        `SELECT language, COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc
         FROM files WHERE role != 'asset'
         GROUP BY language ORDER BY loc DESC`,
      )
      .all() as Array<{ language: string; files: number; loc: number }>
  ).map((row) => ({
    language: row.language as Language,
    files: row.files,
    loc: row.loc,
    share: row.loc / totalLoc,
  }));

  const packages = (
    db
      .prepare(
        `SELECT p.name, p.dir, p.manager,
                COALESCE(SUM(f.loc), 0) AS loc,
                COUNT(f.id) AS files
         FROM packages p
         LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
         GROUP BY p.id
         ORDER BY loc DESC`,
      )
      .all() as Array<{ name: string; dir: string; manager: string; loc: number; files: number }>
  ).map((row) => ({
    id: `pkg:${row.name}`,
    name: row.name,
    dir: row.dir,
    manager: row.manager as OverviewDto["packages"][number]["manager"],
    loc: row.loc,
    files: row.files,
  }));

  const layers = (db
    .prepare("SELECT name, description, members FROM layers ORDER BY ordinal, id")
    .all() as Array<{ name: string; description: string; members: string }>).map((row) => ({
      name: row.name,
      description: row.description,
      nodeIds: parseStringArray(row.members),
    }));
  const llmStatus = readLlmStatus(db);

  return {
    repoName: getMeta(db, "repo_name") ?? "repo",
    repoRoot: getMeta(db, "repo_root") ?? "",
    scannedAt: getMeta(db, "scanned_at") ?? "",
    totals,
    lastScan: {
      durationMs: lastRun.durationMs ?? 0,
      filesParsed: lastRun.filesParsed ?? 0,
      filesReused: lastRun.filesReused ?? 0,
      filesDeleted: lastRun.filesDeleted ?? 0,
      parseErrors: lastRun.parseErrors ?? 0,
    },
    languages,
    packages,
    summary: readSummary(db, "repo", "."),
    summaryUnavailableReason: lastRun.llm?.reason ?? null,
    layers: layers.length > 0 ? layers : null,
    llm: llmStatus as LlmStatusDto | null,
  };
}

/** 索引总量一律现算。存下来的数只会在下一次增量扫描后变成谎话。 */
export function getIndexTotals(db: Db): IndexTotals {
  const one = <T>(sql: string, fallback: T): T => (db.prepare(sql).get() as { v: T }).v ?? fallback;

  // 用 confidence 而不是 target_file_id 判断是否解析成功：Go 的包级
  // import 落在目录上，没有对应的文件 id，但它是被解析出来的
  const imports = db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(confidence = 'external'), 0) AS external,
              COALESCE(SUM(confidence = 'unresolved'), 0) AS unresolved
       FROM imports`,
    )
    .get() as { total: number; external: number; unresolved: number };

  return {
    files: one("SELECT COUNT(*) AS v FROM files WHERE role != 'asset'", 0),
    loc: one("SELECT COALESCE(SUM(loc), 0) AS v FROM files WHERE role != 'asset'", 0),
    symbols: one("SELECT COUNT(*) AS v FROM symbols", 0),
    calls: one("SELECT COUNT(*) AS v FROM call_sites", 0),
    imports: imports.total,
    importsResolved: imports.total - imports.external - imports.unresolved,
    importsExternal: imports.external,
    importsUnresolved: imports.unresolved,
    packages: one("SELECT COUNT(*) AS v FROM packages", 0),
  };
}

// ---------------------------------------------------------------------------
// 目录树
// ---------------------------------------------------------------------------

/**
 * 取某目录下的树。
 *
 * 一次只返回 `depth` 层，不返回整棵树：40 万行仓库的完整树有上千节点，
 * 而用户展开的永远只是其中一条路径。
 */
export function getTree(db: Db, path = ".", depth = 1, roles = DEFAULT_ROLES): TreeNodeDto {
  const self = treeNodeForDir(db, path);
  self.children = depth > 0 ? treeChildren(db, path, depth - 1, roles) : null;
  return self;
}

function treeNodeForDir(db: Db, path: string): TreeNodeDto {
  if (path === ".") {
    const totals = db
      .prepare(
        `SELECT COALESCE(SUM(loc), 0) AS loc, COUNT(*) AS files, COALESCE(SUM(complexity), 0) AS complexity
         FROM files WHERE role = 'source'`,
      )
      .get() as { loc: number; files: number; complexity: number };
    const symbols = (db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    return {
      id: "dir:.",
      name: getMeta(db, "repo_name") ?? "repo",
      path: ".",
      kind: "directory",
      loc: totals.loc,
      files: totals.files,
      symbols,
      complexity: totals.complexity,
      heat: 1,
      hasChildren: true,
      children: null,
    };
  }

  const row = db
    .prepare(
      "SELECT path, name, loc, file_count AS files, symbol_count AS symbols, complexity FROM directories WHERE path = ?",
    )
    .get(path) as
    | { path: string; name: string; loc: number; files: number; symbols: number; complexity: number }
    | undefined;

  if (!row) {
    return {
      id: `dir:${path}`,
      name: baseName(path),
      path,
      kind: "directory",
      loc: 0,
      files: 0,
      symbols: 0,
      complexity: 0,
      heat: 0,
      hasChildren: false,
      children: null,
    };
  }

  return {
    id: `dir:${row.path}`,
    name: row.name,
    path: row.path,
    kind: "directory",
    loc: row.loc,
    files: row.files,
    symbols: row.symbols,
    complexity: row.complexity,
    heat: 0,
    hasChildren: true,
    children: null,
  };
}

function treeChildren(db: Db, parent: string, remainingDepth: number, roles: FileRole[]): TreeNodeDto[] {
  const dirRows = db
    .prepare(
      `SELECT path, name, loc, file_count AS files, symbol_count AS symbols, complexity
       FROM directories WHERE parent_path IS ? AND file_count > 0
       ORDER BY loc DESC`,
    )
    .all(parent === "." ? null : parent) as Array<{
    path: string;
    name: string;
    loc: number;
    files: number;
    symbols: number;
    complexity: number;
  }>;

  // 根目录的直接子目录在 directories 表里 parent_path 为 null，需要单独兜一次
  const rootDirs =
    parent === "."
      ? (db
          .prepare(
            `SELECT path, name, loc, file_count AS files, symbol_count AS symbols, complexity
             FROM directories WHERE depth = 1 AND file_count > 0 ORDER BY loc DESC`,
          )
          .all() as typeof dirRows)
      : [];

  const dirs = parent === "." ? rootDirs : dirRows;

  const placeholders = roles.map(() => "?").join(",");
  const fileRows = db
    .prepare(
      `SELECT id, path, name, language, role, loc, complexity,
              (SELECT COUNT(*) FROM symbols s WHERE s.file_id = files.id) AS symbols
       FROM files WHERE dir_path = ? AND role IN (${placeholders})
       ORDER BY loc DESC`,
    )
    .all(parent, ...roles) as Array<{
    id: number;
    path: string;
    name: string;
    language: string;
    role: string;
    loc: number;
    complexity: number;
    symbols: number;
  }>;

  const maxLoc = Math.max(
    1,
    ...dirs.map((d) => d.loc),
    ...fileRows.map((f) => f.loc),
  );

  const children: TreeNodeDto[] = [];

  for (const dir of dirs) {
    children.push({
      id: `dir:${dir.path}`,
      name: dir.name,
      path: dir.path,
      kind: "directory",
      loc: dir.loc,
      files: dir.files,
      symbols: dir.symbols,
      complexity: dir.complexity,
      heat: dir.loc / maxLoc,
      hasChildren: true,
      children: remainingDepth > 0 ? treeChildren(db, dir.path, remainingDepth - 1, roles) : null,
    });
  }

  for (const file of fileRows) {
    children.push({
      id: `file:${file.id}`,
      name: file.name,
      path: file.path,
      kind: "file",
      language: file.language as Language,
      role: file.role as FileRole,
      loc: file.loc,
      files: 1,
      symbols: file.symbols,
      complexity: file.complexity,
      heat: file.loc / maxLoc,
      hasChildren: file.symbols > 0,
      children: null,
    });
  }

  return children;
}

// ---------------------------------------------------------------------------
// 图
// ---------------------------------------------------------------------------

/**
 * 构造某作用域下的一层图。
 *
 * 「一层」的含义是：只返回该作用域的直接子成员作为节点，成员之间的依赖
 * 由底层边聚合而来。这是 docs/INTERACTION.md 里渐进式下钻的数据基础——
 * 前端永远只持有当前这一层。
 */
export function getScopeGraph(db: Db, options: GraphOptions = {}): GraphDto {
  const scope = options.scope ?? ROOT_SCOPE;
  const limit = options.limit ?? 30;
  const roles = options.roles ?? DEFAULT_ROLES;
  const includeExternal = options.includeExternal ?? false;
  const keep = options.keep;

  if (scope === ROOT_SCOPE) {
    const packageGraph = tryPackageGraph(db, limit, includeExternal, keep);
    if (packageGraph) return packageGraph;
  }

  if (scope.startsWith("pkg:")) {
    const pkgDir = packageDir(db, scope.slice(4));
    return pkgDir === null
      ? emptyGraph()
      : directoryScopeGraph(db, pkgDir, limit, roles, includeExternal, keep);
  }

  if (scope.startsWith("dir:")) {
    return directoryScopeGraph(db, scope.slice(4), limit, roles, includeExternal, keep);
  }

  if (scope.startsWith("file:")) {
    return fileSymbolGraph(db, Number(scope.slice(5)), limit, keep);
  }

  // 不认识的 scope 一律报错。返回空图会让「点了没反应」看起来像布局问题，
  // 而真正的原因是某处拼错了 scope id——这个坑已经踩过一次。
  throw new Error(`未知的 scope：${scope}（应为 pkg: / dir: / file: 前缀）`);
}

/** 包数量 < 2 时包级视图没有信息量，退化成顶层目录视图 */
function tryPackageGraph(
  db: Db,
  limit: number,
  includeExternal: boolean,
  keep?: string | undefined,
): GraphDto | null {
  const rows = db
    .prepare(
      `SELECT p.name, p.dir, p.manager,
              COALESCE(SUM(f.loc), 0) AS loc,
              COUNT(f.id) AS files,
              COALESCE(SUM(f.complexity), 0) AS complexity
       FROM packages p
       LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
       GROUP BY p.id ORDER BY p.dir, p.name`,
    )
    .all() as Array<{
    name: string;
    dir: string;
    manager: string;
    loc: number;
    files: number;
    complexity: number;
  }>;

  const meaningful = rows.filter((r) => r.files > 0);
  if (meaningful.length < 2) return null;

  const symbolCounts = new Map(
    (
      db
        .prepare(
          `SELECT p.name AS name, COUNT(s.id) AS n
           FROM packages p
           JOIN files f ON f.package_id = p.id
           JOIN symbols s ON s.file_id = f.id
           GROUP BY p.id`,
        )
        .all() as Array<{ name: string; n: number }>
    ).map((r) => [r.name, r.n]),
  );

  const nodes: GraphNodeDto[] = meaningful.map((row) => ({
    id: `pkg:${row.name}`,
    kind: "package",
    label: row.name,
    path: row.dir,
    metrics: {
      loc: row.loc,
      files: row.files,
      symbols: symbolCounts.get(row.name) ?? 0,
      complexity: row.complexity,
      inDegree: 0,
      outDegree: 0,
    },
    childCount: row.files,
    expandable: row.files > 0,
  }));

  const edgeRows = db
    .prepare(
      `SELECT src, dst, confidence, count FROM rollup_edges
       WHERE level = 'package' AND type = 'imports'`,
    )
    .all() as Array<{ src: string; dst: string; confidence: string; count: number }>;

  const edges: GraphEdgeDto[] = edgeRows.map((row) => ({
    id: `pkg:${row.src}->pkg:${row.dst}`,
    source: `pkg:${row.src}`,
    target: `pkg:${row.dst}`,
    type: "imports",
    confidence: row.confidence as Confidence,
    weight: row.count,
    count: row.count,
  }));

  // scopeKey 必须是这张图真实挂载的 scope id：前端把聚合节点的 "agg:" 前缀
  // 剥掉后直接拿去请求父作用域，写成 "pkg" 会请求到一个不存在的 scope，
  // 表现为根视图的「其他 N 项」点了没反应。包级图服务的正是 dir:. 。
  return finalizeGraph(db, nodes, edges, limit, includeExternal, ROOT_SCOPE, keep);
}

function directoryScopeGraph(
  db: Db,
  scopeDir: string,
  limit: number,
  roles: FileRole[],
  includeExternal: boolean,
  keep?: string | undefined,
): GraphDto {
  const childDirs = db
    .prepare(
      `SELECT path, name, loc, file_count AS files, symbol_count AS symbols, complexity
       FROM directories
       WHERE ${scopeDir === "." ? "depth = 1" : "parent_path = ?"} AND file_count > 0
       ORDER BY path`,
    )
    .all(...(scopeDir === "." ? [] : [scopeDir])) as Array<{
    path: string;
    name: string;
    loc: number;
    files: number;
    symbols: number;
    complexity: number;
  }>;

  const placeholders = roles.map(() => "?").join(",");
  const looseFiles = db
    .prepare(
      `SELECT id, path, name, language, role, loc, complexity,
              (SELECT COUNT(*) FROM symbols s WHERE s.file_id = files.id) AS symbols
       FROM files WHERE dir_path = ? AND role IN (${placeholders}) ORDER BY path`,
    )
    .all(scopeDir, ...roles) as Array<{
    id: number;
    path: string;
    name: string;
    language: string;
    role: string;
    loc: number;
    complexity: number;
    symbols: number;
  }>;

  const nodes: GraphNodeDto[] = [];
  /** 底层目录路径 → 本层节点 id 的归组映射 */
  const groupOf = new Map<string, string>();

  for (const dir of childDirs) {
    const id = `dir:${dir.path}`;
    nodes.push({
      id,
      kind: "directory",
      label: dir.name,
      path: dir.path,
      metrics: {
        loc: dir.loc,
        files: dir.files,
        symbols: dir.symbols,
        complexity: dir.complexity,
        inDegree: 0,
        outDegree: 0,
      },
      childCount: dir.files,
      expandable: true,
    });
    groupOf.set(dir.path, id);
  }

  for (const file of looseFiles) {
    const id = `file:${file.id}`;
    nodes.push({
      id,
      kind: "file",
      label: file.name,
      path: file.path,
      language: file.language as Language,
      role: file.role as FileRole,
      metrics: {
        loc: file.loc,
        files: 1,
        symbols: file.symbols,
        complexity: file.complexity,
        inDegree: 0,
        outDegree: 0,
      },
      childCount: file.symbols,
      expandable: file.symbols > 0,
    });
  }

  // 目录级 rollup 边的端点是文件的直接父目录，需要向上归并到本层节点
  const rollups = db
    .prepare(
      "SELECT src, dst, confidence, count FROM rollup_edges WHERE level = 'directory' AND type = 'imports'",
    )
    .all() as Array<{ src: string; dst: string; confidence: string; count: number }>;

  const fileNodeByDir = new Map<string, string>();
  for (const file of looseFiles) fileNodeByDir.set(file.path, `file:${file.id}`);

  const resolveGroup = (dirPath: string): string | null => {
    if (!isWithin(scopeDir, dirPath)) return null;
    if (dirPath === scopeDir) return null; // 直接挂在作用域下的文件，由文件级边处理
    const direct = groupOf.get(dirPath);
    if (direct) return direct;
    // 向上找最近的本层祖先
    let cursor = dirPath;
    while (cursor !== "." && cursor !== scopeDir) {
      const hit = groupOf.get(cursor);
      if (hit) return hit;
      cursor = dirOf(cursor);
    }
    return null;
  };

  const aggregated = new Map<string, GraphEdgeDto>();
  const bump = (source: string, target: string, confidence: Confidence, count: number) => {
    if (source === target) return;
    const key = `${source}->${target}`;
    const existing = aggregated.get(key);
    if (existing) {
      existing.count += count;
      existing.weight += count;
      return;
    }
    aggregated.set(key, {
      id: key,
      source,
      target,
      type: "imports",
      confidence,
      weight: count,
      count,
    });
  };

  for (const row of rollups) {
    const source = resolveGroup(row.src);
    const target = resolveGroup(row.dst);
    if (source === null || target === null) continue;
    bump(source, target, row.confidence as Confidence, row.count);
  }

  // 作用域下的散装文件之间的边要从文件级 edges 表直接取
  if (looseFiles.length > 0) {
    const ids = looseFiles.map((f) => f.id);
    const inClause = ids.map(() => "?").join(",");
    const fileEdges = db
      .prepare(
        `SELECT sf.path AS srcPath, tf.path AS dstPath, e.confidence, COUNT(*) AS count
         FROM edges e
         JOIN files sf ON sf.id = e.src_id
         JOIN files tf ON tf.id = e.dst_id
         WHERE e.type = 'imports' AND e.src_kind = 'file' AND e.dst_kind = 'file'
           AND (e.src_id IN (${inClause}) OR e.dst_id IN (${inClause}))
         GROUP BY sf.path, tf.path, e.confidence`,
      )
      .all(...ids, ...ids) as Array<{
      srcPath: string;
      dstPath: string;
      confidence: string;
      count: number;
    }>;

    for (const row of fileEdges) {
      const source = fileNodeByDir.get(row.srcPath) ?? resolveGroup(dirOf(row.srcPath));
      const target = fileNodeByDir.get(row.dstPath) ?? resolveGroup(dirOf(row.dstPath));
      if (!source || !target) continue;
      bump(source, target, row.confidence as Confidence, row.count);
    }
  }

  return finalizeGraph(
    db,
    nodes,
    [...aggregated.values()],
    limit,
    includeExternal,
    `dir:${scopeDir}`,
    keep,
  );
}

/** 文件内的符号视图：文件里的符号 + 它们之间的调用边。 */
function fileSymbolGraph(
  db: Db,
  fileId: number,
  limit: number,
  keep?: string | undefined,
): GraphDto {
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, s.exported, s.complexity,
              s.start_line AS startLine, s.end_line AS endLine, f.path, f.language
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.file_id = ?
       ORDER BY s.start_line`,
    )
    .all(fileId) as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    exported: number;
    complexity: number;
    startLine: number;
    endLine: number;
    path: string;
    language: string;
  }>;

  const nodes: GraphNodeDto[] = rows.map((row) => ({
    id: `sym:${row.id}`,
    kind: "symbol",
    label: row.container !== null ? `${row.container}.${row.name}` : row.name,
    path: row.path,
    language: row.language as Language,
    symbolKind: row.kind as SymbolKind,
    metrics: {
      loc: row.endLine - row.startLine + 1,
      files: 0,
      symbols: 1,
      complexity: row.complexity,
      inDegree: 0,
      outDegree: 0,
    },
    childCount: 0,
    expandable: false,
  }));

  // 只画文件内部的调用。跨文件的目标不在这张图上，硬画会得到一堆
  // 指向画布之外的悬空边；它们在符号详情的「调用方/被调用」里看。
  const inFile = new Set(rows.map((r) => r.id));
  const edges: GraphEdgeDto[] = (
    db
      .prepare(
        `SELECT src_id AS src, dst_id AS dst, confidence, weight
         FROM edges
         WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
           AND src_id IN (SELECT id FROM symbols WHERE file_id = ?)`,
      )
      .all(fileId) as Array<{ src: number; dst: number; confidence: string; weight: number }>
  )
    .filter((row) => inFile.has(row.dst) && row.src !== row.dst)
    .map((row) => ({
      id: `sym:${row.src}->sym:${row.dst}`,
      source: `sym:${row.src}`,
      target: `sym:${row.dst}`,
      type: "calls" as const,
      confidence: row.confidence as Confidence,
      weight: row.weight,
      count: row.weight,
    }));

  return finalizeGraph(db, nodes, edges, limit, false, `file:${fileId}`, keep);
}

/**
 * 以一个符号为中心，向上下游各展开若干跳的调用图。
 *
 * 这是「看懂一个函数在整个仓库里怎么被用」的入口，和按目录下钻是两条
 * 正交的浏览路径：目录回答「有什么」，这里回答「谁调它、它调谁」。
 *
 * 广度优先并且每层限量。调用图的分支因子在热点函数上能到三位数
 * （pi 里 TUI.requestRender 有 134 个调用方），不设限的两跳展开
 * 会直接拉出上万个节点。
 */
export function getCallGraph(db: Db, options: CallGraphOptions): GraphDto {
  const depth = Math.min(Math.max(options.depth ?? 1, 1), 4);
  const perLevel = Math.min(Math.max(options.limit ?? 12, 1), 200);
  const direction = options.direction ?? "both";
  const confidence = options.confidence ?? ["exact", "likely"];

  const confList = confidence.map(() => "?").join(",");
  const step = {
    callees: db.prepare(
      `SELECT dst_id AS next, confidence, weight FROM edges
       WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
         AND src_id = ? AND confidence IN (${confList})
       ORDER BY weight DESC LIMIT ?`,
    ),
    callers: db.prepare(
      `SELECT src_id AS next, confidence, weight FROM edges
       WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
         AND dst_id = ? AND confidence IN (${confList})
       ORDER BY weight DESC LIMIT ?`,
    ),
  };

  const seen = new Set<number>([options.symbolId]);
  const edges = new Map<string, GraphEdgeDto>();
  let frontier = [options.symbolId];

  for (let hop = 0; hop < depth && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const dir of ["callees", "callers"] as const) {
        if (direction !== "both" && direction !== dir) continue;
        const rows = step[dir].all(id, ...confidence, perLevel) as Array<{
          next: number;
          confidence: string;
          weight: number;
        }>;
        for (const row of rows) {
          const [src, dst] = dir === "callees" ? [id, row.next] : [row.next, id];
          const key = `${src}->${dst}`;
          if (!edges.has(key)) {
            edges.set(key, {
              id: `sym:${src}->sym:${dst}`,
              source: `sym:${src}`,
              target: `sym:${dst}`,
              type: "calls",
              confidence: row.confidence as Confidence,
              weight: row.weight,
              count: row.weight,
            });
          }
          if (!seen.has(row.next)) {
            seen.add(row.next);
            next.push(row.next);
          }
        }
      }
    }
    frontier = next;
  }

  const nodes = symbolNodes(db, [...seen], options.symbolId);
  attachSemantics(db, nodes);
  attachFindings(db, nodes);
  // 这里不走 finalizeGraph 的折叠：中心节点被折进「其他 N 项」的话
  // 整张图就没有锚点了，而每层限量已经把规模控住了。
  const normalizedEdges = normalizeEdges(nodes, [...edges.values()]);
  attachDetailRelationCounts(db, nodes);
  return {
    nodes,
    edges: normalizedEdges,
    truncated: omittedAtCenter(db, options.symbolId, direction, confidence, perLevel),
  };
}

/**
 * 中心节点这一层被截掉了多少条边。
 *
 * 只算中心一层：热点函数的邻居数是唯一会让人误判的地方（pi 里
 * TUI.requestRender 有 127 个调用方，图上画 12 个），更外层的截断
 * 在视觉上本来就表现为「这条链走到头了」。不报出来的话，一张画了
 * 12 个调用方的图会被当成全部调用方。
 */
function omittedAtCenter(
  db: Db,
  symbolId: number,
  direction: "callers" | "callees" | "both",
  confidence: readonly Confidence[],
  perLevel: number,
): number {
  const confList = confidence.map(() => "?").join(",");
  const count = (column: "src_id" | "dst_id") =>
    (
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM edges
           WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol'
             AND ${column} = ? AND confidence IN (${confList})`,
        )
        .get(symbolId, ...confidence) as { n: number }
    ).n;

  let omitted = 0;
  if (direction !== "callers") omitted += Math.max(0, count("src_id") - perLevel);
  if (direction !== "callees") omitted += Math.max(0, count("dst_id") - perLevel);
  return omitted;
}

function symbolNodes(db: Db, ids: readonly number[], focusId: number): GraphNodeDto[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, s.complexity,
              s.start_line AS startLine, s.end_line AS endLine,
              f.path, f.language, f.role
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.id IN (${placeholders}) ORDER BY f.path, s.start_line, s.id`,
    )
    .all(...ids) as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    complexity: number;
    startLine: number;
    endLine: number;
    path: string;
    language: string;
    role: string;
  }>;

  return rows.map((row) => ({
    id: `sym:${row.id}`,
    kind: "symbol" as const,
    label: row.container !== null ? `${row.container}.${row.name}` : row.name,
    path: row.path,
    language: row.language as Language,
    role: row.role as FileRole,
    symbolKind: row.kind as SymbolKind,
    metrics: {
      loc: row.endLine - row.startLine + 1,
      files: 0,
      symbols: 1,
      complexity: row.complexity,
      inDegree: 0,
      outDegree: 0,
    },
    childCount: 0,
    expandable: false,
    // 中心节点要能在界面上被认出来，否则展开两跳之后就找不到出发点了
    focus: row.id === focusId,
  }));
}

/**
 * 收尾：按主指标折叠超额节点、可选挂上 external 聚合节点、回填度数。
 *
 * 折叠是「删除」策略的兜底——无论数据多大，默认视图的节点数都不会超过 limit。
 */
function finalizeGraph(
  db: Db,
  nodes: GraphNodeDto[],
  edges: GraphEdgeDto[],
  limit: number,
  includeExternal: boolean,
  scopeKey: string,
  keep?: string | undefined,
): GraphDto {
  let finalNodes = nodes;
  let finalEdges = edges;
  let truncated = 0;

  // 摘要和体检角标都要在折叠之前挂，聚合节点本身不冒充有语义。
  attachSemantics(db, nodes);
  attachFindings(db, nodes);

  if (nodes.length > limit) {
    const sorted = [...nodes].sort((a, b) => b.metrics.loc - a.metrics.loc || a.id.localeCompare(b.id));
    // 被锁住的节点排到最前，这样它一定落在保留区里
    if (keep !== undefined) {
      const at = sorted.findIndex((n) => n.id === keep);
      if (at > 0) sorted.unshift(...sorted.splice(at, 1));
    }
    const kept = sorted.slice(0, limit - 1);
    const folded = sorted.slice(limit - 1);
    truncated = folded.length;

    const aggId = `agg:${scopeKey}`;
    const foldedIds = new Set(folded.map((n) => n.id));
    const aggNode: GraphNodeDto = {
      id: aggId,
      kind: "aggregate",
      label: `其他 ${folded.length} 项`,
      metrics: {
        loc: folded.reduce((s, n) => s + n.metrics.loc, 0),
        files: folded.reduce((s, n) => s + n.metrics.files, 0),
        symbols: folded.reduce((s, n) => s + n.metrics.symbols, 0),
        complexity: folded.reduce((s, n) => s + n.metrics.complexity, 0),
        inDegree: 0,
        outDegree: 0,
      },
      childCount: folded.length,
      expandable: true,
      aggregatedIds: folded.map((n) => n.id),
    };

    finalNodes = [...kept, aggNode];

    const remapped = new Map<string, GraphEdgeDto>();
    for (const edge of edges) {
      const source = foldedIds.has(edge.source) ? aggId : edge.source;
      const target = foldedIds.has(edge.target) ? aggId : edge.target;
      if (source === target) continue;
      const key = `${source}->${target}`;
      const existing = remapped.get(key);
      if (existing) {
        existing.count += edge.count;
        existing.weight += edge.weight;
        continue;
      }
      remapped.set(key, { ...edge, id: key, source, target });
    }
    finalEdges = [...remapped.values()];
  }

  if (includeExternal) {
    const externalEdges = collectExternalEdges(db, finalNodes);
    if (externalEdges.length > 0) {
      finalNodes = [...finalNodes, externalNode(externalEdges)];
      finalEdges = [...finalEdges, ...externalEdges];
    }
  }

  const nodeIds = new Set(finalNodes.map((n) => n.id));
  finalEdges = finalEdges.filter((e) => nodeIds.has(e.source) && nodeIds.has(e.target));

  const normalizedEdges = normalizeEdges(finalNodes, finalEdges);
  attachDetailRelationCounts(db, finalNodes);
  return { nodes: finalNodes, edges: normalizedEdges, truncated };
}

/**
 * 回填度数并把 weight 归一化到 0..1。
 *
 * 归一化必须在服务端做，因为前端拿到的只是一层子图，它看不到全局最大值。
 * 而边宽直接用 weight 算（1 + w * 2.4），漏掉这步会让一条 count=49 的边
 * 渲染成 118 像素宽的色块。
 */
function normalizeEdges(nodes: readonly GraphNodeDto[], edges: GraphEdgeDto[]): GraphEdgeDto[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const edge of edges) {
    const src = byId.get(edge.source);
    const dst = byId.get(edge.target);
    if (src) src.metrics.outDegree++;
    if (dst) dst.metrics.inDegree++;
  }

  const maxWeight = Math.max(1, ...edges.map((e) => e.weight));
  for (const edge of edges) edge.weight = edge.weight / maxWeight;
  return edges.sort((a, b) =>
    a.source.localeCompare(b.source) || a.target.localeCompare(b.target) || a.id.localeCompare(b.id),
  );
}

/**
 * 文件和符号卡片展示的是对象自身的完整关系统计，而不是当前画布恰好可见的边数。
 *
 * 例如一个文件有 5 条 import 声明，但其中两条指向同一文件、另一条跨出当前
 * 目录时，局部图只会画出 3 个目标节点。若直接使用图的 degree，卡片显示 3，
 * 点开详情却显示 5。这里在完成边布局统计后覆写叶子节点，使两个位置口径一致。
 * 包、目录和聚合节点仍保留当前层的聚合边数，因为它们没有独立的详情关系表。
 */
function attachDetailRelationCounts(db: Db, nodes: readonly GraphNodeDto[]): void {
  const fileIds = nodes
    .filter((node) => node.kind === "file")
    .map((node) => Number(node.id.slice("file:".length)))
    .filter(Number.isInteger);
  const symbolIds = nodes
    .filter((node) => node.kind === "symbol")
    .map((node) => Number(node.id.slice("sym:".length)))
    .filter(Number.isInteger);

  const fileOutgoing = groupedCounts(
    db, fileIds,
    "SELECT file_id AS id, COUNT(*) AS n FROM imports WHERE file_id IN",
    "GROUP BY file_id",
  );
  const fileIncoming = groupedCounts(
    db, fileIds,
    `SELECT dst_id AS id, COUNT(DISTINCT src_id) AS n FROM edges
     WHERE type = 'imports' AND src_kind = 'file' AND dst_kind = 'file' AND dst_id IN`,
    "GROUP BY dst_id",
  );
  const symbolOutgoing = groupedCounts(
    db, symbolIds,
    `SELECT src_id AS id, COUNT(*) AS n FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND src_id IN`,
    "GROUP BY src_id",
  );
  const symbolIncoming = groupedCounts(
    db, symbolIds,
    `SELECT dst_id AS id, COUNT(*) AS n FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND dst_id IN`,
    "GROUP BY dst_id",
  );

  for (const node of nodes) {
    if (node.kind === "file") {
      const id = Number(node.id.slice("file:".length));
      node.metrics.outDegree = fileOutgoing.get(id) ?? 0;
      node.metrics.inDegree = fileIncoming.get(id) ?? 0;
    } else if (node.kind === "symbol") {
      const id = Number(node.id.slice("sym:".length));
      // 详情关系列表目前最多返回 200 项，数字也遵循相同上限。
      node.metrics.outDegree = Math.min(symbolOutgoing.get(id) ?? 0, 200);
      node.metrics.inDegree = Math.min(symbolIncoming.get(id) ?? 0, 200);
    }
  }
}

/** SQLite 默认参数上限因构建而异，分批查询避免大调用图越界。 */
function groupedCounts(
  db: Db,
  ids: readonly number[],
  sqlBeforeIn: string,
  sqlAfterIn: string,
): Map<number, number> {
  const counts = new Map<number, number>();
  for (let offset = 0; offset < ids.length; offset += 400) {
    const batch = ids.slice(offset, offset + 400);
    const placeholders = batch.map(() => "?").join(",");
    const rows = db
      .prepare(`${sqlBeforeIn} (${placeholders}) ${sqlAfterIn}`)
      .all(...batch) as Array<{ id: number; n: number }>;
    for (const row of rows) counts.set(row.id, row.n);
  }
  return counts;
}

function collectExternalEdges(db: Db, nodes: readonly GraphNodeDto[]): GraphEdgeDto[] {
  const scopes = nodes
    .filter((n) => n.kind === "directory" || n.kind === "package" || n.kind === "file")
    .map((n) => ({ id: n.id, path: n.path ?? "" }))
    .filter((n) => n.path.length > 0);
  if (scopes.length === 0) return [];

  const rows = db
    .prepare(
      `SELECT f.path AS path, COUNT(*) AS count
       FROM edges e JOIN files f ON f.id = e.src_id
       WHERE e.dst_kind = 'external' AND e.src_kind = 'file'
       GROUP BY f.path`,
    )
    .all() as Array<{ path: string; count: number }>;

  const totals = new Map<string, number>();
  for (const row of rows) {
    // 最长前缀匹配，把外部依赖计数归给最具体的那个本层节点
    let best: { id: string; len: number } | null = null;
    for (const scope of scopes) {
      if (!isWithin(scope.path, row.path)) continue;
      const len = scope.path.length;
      if (!best || len > best.len) best = { id: scope.id, len };
    }
    if (!best) continue;
    totals.set(best.id, (totals.get(best.id) ?? 0) + row.count);
  }

  return [...totals.entries()].map(([source, count]) => ({
    id: `${source}->external`,
    source,
    target: EXTERNAL_NODE_ID,
    type: "imports" as const,
    confidence: "external" as const,
    weight: count,
    count,
  }));
}

function externalNode(edges: readonly GraphEdgeDto[]): GraphNodeDto {
  const total = edges.reduce((s, e) => s + e.count, 0);
  return {
    id: EXTERNAL_NODE_ID,
    kind: "external",
    label: `外部依赖 (${total})`,
    metrics: { loc: 0, files: 0, symbols: 0, complexity: 0, inDegree: 0, outDegree: 0 },
    childCount: 0,
    expandable: false,
  };
}

function emptyGraph(): GraphDto {
  return { nodes: [], edges: [], truncated: 0 };
}

function packageDir(db: Db, name: string): string | null {
  const row = db.prepare("SELECT dir FROM packages WHERE name = ?").get(name) as
    | { dir: string }
    | undefined;
  return row?.dir ?? null;
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

export function getFileDetail(db: Db, fileId: number): FileDetailDto | null {
  const file = db
    .prepare(
      `SELECT f.id, f.path, f.language, f.role, f.loc, f.bytes, f.hash, f.parse_error AS parseError,
              p.name AS packageName
       FROM files f LEFT JOIN packages p ON p.id = f.package_id
       WHERE f.id = ?`,
    )
    .get(fileId) as
    | {
        id: number;
        path: string;
        language: string;
        role: string;
        loc: number;
        bytes: number;
        hash: string;
        parseError: string | null;
        packageName: string | null;
      }
    | undefined;

  if (!file) return null;

  const symbols = db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, s.exported, s.signature,
              s.start_line AS startLine, s.end_line AS endLine, s.complexity,
              (SELECT COUNT(*) FROM edges e WHERE e.type = 'calls' AND e.dst_kind = 'symbol' AND e.dst_id = s.id) AS callerCount,
              (SELECT COUNT(*) FROM edges e WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.src_id = s.id) AS calleeCount
       FROM symbols s WHERE s.file_id = ? ORDER BY s.start_line`,
    )
    .all(fileId) as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    exported: number;
    signature: string | null;
    startLine: number;
    endLine: number;
    complexity: number;
    callerCount: number;
    calleeCount: number;
  }>;

  const imports = db
    .prepare(
      `SELECT i.id, i.raw_source AS rawSource, i.kind, i.confidence, tf.path AS targetPath, i.line
       FROM imports i LEFT JOIN files tf ON tf.id = i.target_file_id
       WHERE i.file_id = ? ORDER BY i.line`,
    )
    .all(fileId) as Array<{
    id: number;
    rawSource: string;
    kind: string;
    confidence: string;
    targetPath: string | null;
    line: number;
  }>;

  const specStmt = db.prepare("SELECT local FROM import_specifiers WHERE import_id = ?");

  return {
    id: `file:${file.id}`,
    path: file.path,
    language: file.language as Language,
    role: file.role as FileRole,
    loc: file.loc,
    bytes: file.bytes,
    packageName: file.packageName,
    parseError: file.parseError,
    symbols: symbols.map(
      (s): SymbolSummaryDto => ({
        id: `sym:${s.id}`,
        name: s.name,
        kind: s.kind as SymbolKind,
        container: s.container,
        exported: s.exported === 1,
        signature: s.signature,
        startLine: s.startLine,
        endLine: s.endLine,
        loc: s.endLine - s.startLine + 1,
        complexity: s.complexity,
        callerCount: s.callerCount,
        calleeCount: s.calleeCount,
      }),
    ),
    imports: imports.map((imp) => ({
      source: imp.rawSource,
      kind: imp.kind as ImportKind,
      confidence: imp.confidence as Confidence,
      targetPath: imp.targetPath,
      specifiers: (specStmt.all(imp.id) as Array<{ local: string }>).map((s) => s.local),
      line: imp.line,
    })),
    importedBy: (
      db
        .prepare(
          `SELECT DISTINCT sf.id, sf.path FROM edges e
           JOIN files sf ON sf.id = e.src_id
           WHERE e.type = 'imports' AND e.dst_kind = 'file' AND e.dst_id = ?
           ORDER BY sf.path`,
        )
        .all(fileId) as Array<{ id: number; path: string }>
    ).map((row) => ({ id: `file:${row.id}`, path: row.path })),
    summary: readSummary(db, "file", file.path, "summary-v2", file.hash),
    shortSummary: readSummary(db, "file", file.path, "tooltip-summary", file.hash),
    pseudocode: readSummary(db, "file", file.path, "pseudocode", file.hash),
  };
}

export function getSymbolDetail(db: Db, symbolId: number): SymbolDetailDto | null {
  const row = db
    .prepare(
      `SELECT s.*, f.path AS filePath, f.id AS fileId, f.language
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    )
    .get(symbolId) as
    | (Record<string, unknown> & {
        filePath: string;
        fileId: number;
        language: string;
      })
    | undefined;

  if (!row) return null;

  const params: ParamDto[] = row["params"]
    ? (JSON.parse(row["params"] as string) as ParamDto[])
    : [];

  // 两个方向都必须同时约束 src_kind 和 dst_kind。edges 的 id 空间按 kind
  // 分开，文件级调用边的 src_id 是文件 id，只 join 不过滤就会凭空 join 出
  // 一个 id 恰好相同的符号，变成一个根本不存在的调用者。
  const relation = (direction: "callers" | "callees") =>
    db
      .prepare(
        direction === "callers"
          ? `SELECT s.id, s.name, s.kind, f.path, e.line, e.confidence, e.candidates
             FROM edges e JOIN symbols s ON s.id = e.src_id JOIN files f ON f.id = s.file_id
             WHERE e.type = 'calls' AND e.src_kind = 'symbol'
               AND e.dst_kind = 'symbol' AND e.dst_id = ?
             ORDER BY e.weight DESC LIMIT 200`
          : `SELECT s.id, s.name, s.kind, f.path, e.line, e.confidence, e.candidates
             FROM edges e JOIN symbols s ON s.id = e.dst_id JOIN files f ON f.id = s.file_id
             WHERE e.type = 'calls' AND e.dst_kind = 'symbol'
               AND e.src_kind = 'symbol' AND e.src_id = ?
             ORDER BY e.weight DESC LIMIT 200`,
      )
      .all(symbolId) as Array<{
      id: number;
      name: string;
      kind: string;
      path: string;
      line: number | null;
      confidence: string;
      candidates: string | null;
    }>;

  const candidatePaths = db.prepare(
    `SELECT s.id, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  );

  const toRelationDto = (r: ReturnType<typeof relation>[number]): RelationDto => ({
    id: `sym:${r.id}`,
    name: r.name,
    kind: r.kind as SymbolKind,
    path: r.path,
    line: r.line ?? 0,
    confidence: r.confidence as Confidence,
    // ambiguous 的候选必须能看到。只显示一个「猜的」目标而不给出其他可能，
    // 就把不确定性伪装成了确定性——这正是置信度分级想避免的。
    candidates:
      r.candidates === null
        ? null
        : (JSON.parse(r.candidates) as number[])
            .map((id) => candidatePaths.get(id) as { id: number; path: string } | undefined)
            .filter((c): c is { id: number; path: string } => c !== undefined)
            .map((c) => ({ id: `sym:${c.id}`, path: c.path })),
  });

  const externalCallees = db
    .prepare(
      `SELECT dst_name AS name, COUNT(*) AS count FROM edges
       WHERE type = 'calls' AND src_kind = 'symbol' AND src_id = ? AND dst_kind = 'external'
       GROUP BY dst_name ORDER BY count DESC`,
    )
    .all(symbolId) as Array<{ name: string; count: number }>;

  const typeRelations = db
    .prepare(
      "SELECT relation, target, target_id AS targetId FROM type_relations WHERE subject_id = ?",
    )
    .all(symbolId) as Array<{
    relation: "extends" | "implements" | "embeds";
    target: string;
    targetId: number | null;
  }>;

  const name = row["name"] as string;
  const container = (row["container"] as string | null) ?? null;
  const summaryKey = symbolKey(
    row["filePath"],
    container,
    name,
    row["start_line"] as number,
  );

  return {
    id: `sym:${symbolId}`,
    name,
    kind: row["kind"] as SymbolKind,
    container,
    filePath: row["filePath"],
    fileId: `file:${row["fileId"]}`,
    language: row["language"] as Language,
    exported: row["exported"] === 1,
    signature: (row["signature"] as string | null) ?? null,
    params,
    returnType: (row["return_type"] as string | null) ?? null,
    doc: (row["doc"] as string | null) ?? null,
    startLine: row["start_line"] as number,
    endLine: row["end_line"] as number,
    complexity: row["complexity"] as number,
    isAsync: row["is_async"] === 1,
    receiverType: (row["receiver_type"] as string | null) ?? null,
    callers: relation("callers").map(toRelationDto),
    callees: relation("callees").map(toRelationDto),
    externalCallees,
    typeRelations: typeRelations.map((t) => ({
      relation: t.relation,
      target: t.target,
      targetId: t.targetId !== null ? `sym:${t.targetId}` : null,
    })),
    summary: readSummary(db, "symbol", summaryKey, "summary-v2", row["hash"] as string),
    shortSummary: readSummary(db, "symbol", summaryKey, "tooltip-summary", row["hash"] as string),
    pseudocode: readSummary(db, "symbol", summaryKey, "pseudocode", row["hash"] as string),
  };
}

export function symbolKey(
  filePath: string,
  container: string | null,
  name: string,
  startLine?: number,
): string {
  const base = container !== null ? `${filePath}#${container}.${name}` : `${filePath}#${name}`;
  return startLine === undefined ? base : `${base}:${startLine}`;
}

// ---------------------------------------------------------------------------
// 搜索与源码
// ---------------------------------------------------------------------------

export function search(
  db: Db,
  query: string,
  limit = 30,
  roles: FileRole[] = DEFAULT_ROLES,
): SearchHitDto[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];

  // FTS5 的前缀查询需要显式加 *，并且要转义引号避免语法错误
  const ftsQuery = trimmed
    .split(/\s+/)
    .map((term) => `"${term.replace(/"/g, '""')}"*`)
    .join(" ");

  // 角色过滤必须进 SQL 而不是拿到结果再筛：搜 "session" 时测试文件
  // 能占掉前 30 条里的 25 条，事后过滤等于把结果数砍到个位数
  const rolePlaceholders = roles.map(() => "?").join(",");
  const roleFilter = `AND role IN (${rolePlaceholders})`;

  let rows: Array<{ label: string; detail: string; kind: string; ref: string; rank: number }>;
  try {
    rows = db
      .prepare(
        `SELECT label, detail, kind, ref, rank FROM search_index
         WHERE search_index MATCH ? ${roleFilter} ORDER BY rank LIMIT ?`,
      )
      .all(ftsQuery, ...roles, limit) as typeof rows;
  } catch {
    // 查询串含 FTS 保留语法时退化成 LIKE
    rows = db
      .prepare(
        `SELECT label, detail, kind, ref, 0 AS rank FROM search_index
         WHERE label LIKE ? ${roleFilter} LIMIT ?`,
      )
      .all(`%${trimmed}%`, ...roles, limit) as typeof rows;
  }

  return rows.map((row) => ({
    id: row.ref,
    kind: row.kind as SearchHitDto["kind"],
    label: row.label,
    detail: row.detail,
    score: -row.rank,
  }));
}

export function getSource(
  db: Db,
  repoRoot: string,
  fileId: number,
  startLine?: number,
  endLine?: number,
): SourceSliceDto | null {
  const row = db.prepare("SELECT path, language FROM files WHERE id = ?").get(fileId) as
    | { path: string; language: string }
    | undefined;
  if (!row) return null;

  let text: string;
  try {
    text = readFileSync(join(repoRoot, row.path), "utf8");
  } catch {
    return null;
  }

  const lines = text.split("\n");
  const from = Math.max(1, startLine ?? 1);
  const to = Math.min(lines.length, endLine ?? lines.length);

  return {
    path: row.path,
    language: row.language as Language,
    startLine: from,
    endLine: to,
    code: lines.slice(from - 1, to).join("\n"),
  };
}

// ---------------------------------------------------------------------------
// 语义层读取（M3 写入，M1 起就能读，没有就是 null）
// ---------------------------------------------------------------------------

function readSummary(
  db: Db,
  targetKind: string,
  targetKey: string,
  flavor: SemanticTextFlavor = "summary",
  sourceHash?: string,
): string | null {
  const args: unknown[] = [targetKind, targetKey, flavor, semanticLanguage(db)];
  const hashClause = sourceHash === undefined ? "" : "AND source_hash = ?";
  if (sourceHash !== undefined) args.push(sourceHash);
  const row = db
    .prepare(
      `SELECT content FROM summaries
       WHERE target_kind = ? AND target_key = ? AND flavor = ? AND lang = ? ${hashClause}
       ORDER BY created_at DESC LIMIT 1`,
    )
    .get(...args) as { content: string } | undefined;
  if (!row) return null;
  const lang = semanticLanguage(db);
  const content = normalizeSemanticContent(row.content, flavor, lang === "en" ? "en" : "zh");
  return content === "" ? null : content;
}

/** 给图节点挂上扫描期摘要与架构层；结构事实不依赖这些字段。 */
function attachSemantics(db: Db, nodes: GraphNodeDto[]): void {
  if (nodes.length === 0) return;
  const layerByNode = new Map<string, string>();
  for (const row of db.prepare("SELECT name, members FROM layers ORDER BY ordinal").all() as Array<{ name: string; members: string }>) {
    for (const id of parseStringArray(row.members)) if (!layerByNode.has(id)) layerByNode.set(id, row.name);
  }

  const lang = semanticLanguage(db);
  const summary = db.prepare(
    `SELECT content FROM summaries
     WHERE target_kind = ? AND target_key = ? AND flavor = 'summary' AND lang = ?
     ORDER BY created_at DESC LIMIT 1`,
  );
  const symbolSemantic = db.prepare(
    `SELECT sm.content FROM symbols s JOIN files f ON f.id = s.file_id
     JOIN summaries sm ON sm.target_kind = 'symbol'
       AND sm.target_key = (CASE WHEN s.container IS NULL THEN f.path || '#' || s.name
                                ELSE f.path || '#' || s.container || '.' || s.name END) || ':' || s.start_line
       AND sm.flavor = ? AND sm.lang = ? AND sm.source_hash = s.hash
     WHERE s.id = ? ORDER BY sm.created_at DESC LIMIT 1`,
  );
  const fileSemantic = db.prepare(
    `SELECT sm.content FROM files f JOIN summaries sm ON sm.target_kind = 'file'
       AND sm.target_key = f.path AND sm.flavor = ? AND sm.lang = ? AND sm.source_hash = f.hash
     WHERE f.id = ? ORDER BY sm.created_at DESC LIMIT 1`,
  );

  for (const node of nodes) {
    node.layer = layerByNode.get(node.id) ?? null;
    let row: { content: string } | undefined;
    if (node.kind === "package") row = summary.get("package", node.id.slice(4), lang) as { content: string } | undefined;
    else if (node.kind === "directory") row = summary.get("directory", node.path ?? node.id.slice(4), lang) as { content: string } | undefined;
    else if (node.kind === "file") {
      const id = Number(node.id.slice(5));
      row = fileSemantic.get("tooltip-summary", lang, id) as { content: string } | undefined;
      row ??= fileSemantic.get("summary-v2", lang, id) as { content: string } | undefined;
    } else if (node.kind === "symbol") {
      const id = Number(node.id.slice(4));
      row = symbolSemantic.get("tooltip-summary", lang, id) as { content: string } | undefined;
      row ??= symbolSemantic.get("summary-v2", lang, id) as { content: string } | undefined;
    }
    if (!row) node.summary = null;
    else {
      const flavor = node.kind === "file" || node.kind === "symbol"
        ? "tooltip-summary"
        : "summary";
      node.summary = normalizeSemanticContent(
        row.content, flavor, lang === "en" ? "en" : "zh",
      ) || null;
    }
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

export function nodeMetricsZero(): NodeMetrics {
  return { loc: 0, files: 0, symbols: 0, complexity: 0, inDegree: 0, outDegree: 0 };
}

export { depthOf };

// ---------------------------------------------------------------------------
// 架构体检
// ---------------------------------------------------------------------------

/**
 * 给一批图节点挂上体检计数。
 *
 * 上卷是这里的要点：重复实现天然挂在符号上，但如果它只在符号层可见，
 * 人得一路下钻到函数级才能发现问题，等于没做。所以包/目录/文件节点按
 * 路径前缀把子孙的问题数汇总上来，图上任何一层都能看到「这底下有问题」。
 */
export function attachFindings(db: Db, nodes: GraphNodeDto[]): void {
  if (nodes.length === 0) return;

  // 精确命中：节点自身就是问题的挂载点（循环依赖、符号级重复）
  const exact = new Map<string, number>();
  for (const row of db
    .prepare("SELECT scope_key AS k, COUNT(*) AS n FROM findings GROUP BY scope_key")
    .all() as Array<{ k: string; n: number }>) {
    exact.set(row.k, row.n);
  }

  // 前缀命中：子孙的问题上卷给容器节点
  const byPath = db.prepare(
    `SELECT COUNT(*) AS n, SUM(severity = 'high') AS high FROM findings
     WHERE path = ? OR path LIKE ? || '/%'`,
  );

  for (const node of nodes) {
    if (node.kind === "external" || node.kind === "aggregate") continue;

    if (node.kind === "symbol") {
      const n = exact.get(node.id) ?? 0;
      if (n > 0) node.findings = { count: n, high: 0 };
      continue;
    }

    const path = node.path;
    if (path === undefined || path === null) continue;
    const row = byPath.get(path, path) as { n: number; high: number | null };
    const self = exact.get(node.id) ?? 0;
    // 目录/包节点上，自身的循环依赖也算在内；它的 path 就是自己，
    // 所以已经被前缀查询覆盖，不再叠加
    const count = Math.max(row.n, self);
    if (count > 0) node.findings = { count, high: row.high ?? 0 };
  }
}

export function getFindings(db: Db, options: FindingQuery = {}): FindingDto[] {
  const where: string[] = [];
  const args: unknown[] = [];

  if (options.kind) {
    where.push(`kind = ?`);
    args.push(options.kind);
  }
  if (options.scope !== undefined && options.scope !== ROOT_SCOPE) {
    // 作用域过滤走路径前缀，和图上的下钻保持一致
    const path = options.scope.startsWith("dir:") ? options.scope.slice(4) : null;
    if (path !== null) {
      where.push(`(path = ? OR path LIKE ? || '/%')`);
      args.push(path, path);
    }
  }

  const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  // 一组问题只呈现一条。挂在每个成员上是为了图上处处可见，
  // 但清单里重复列出同一件事只会制造噪音
  const rows = db
    .prepare(
      `SELECT group_key AS groupKey, kind, severity, scope_kind AS scopeKind,
              MIN(scope_key) AS scopeKey, MIN(path) AS path,
              MIN(title) AS title, MIN(detail) AS detail, MIN(related) AS related,
              COUNT(*) AS members
       FROM findings ${clause}
       GROUP BY group_key
       ORDER BY CASE severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
                members DESC, groupKey
       LIMIT ?`,
    )
    .all(...args, options.limit ?? 200) as Array<{
    groupKey: string;
    kind: string;
    severity: string;
    scopeKind: string;
    scopeKey: string;
    path: string;
    title: string;
    detail: string;
    related: string;
    members: number;
  }>;

  return rows.map((r) => ({
    groupKey: r.groupKey,
    kind: r.kind as FindingKind,
    severity: r.severity as FindingSeverity,
    scopeKind: r.scopeKind as FindingDto["scopeKind"],
    scopeKey: r.scopeKey,
    path: r.path,
    title: r.title,
    detail: r.detail,
    related: JSON.parse(r.related) as string[],
    members: r.members,
  }));
}

export function getFindingSummary(db: Db): FindingSummaryDto {
  const rows = db
    .prepare(
      `SELECT kind, severity, COUNT(DISTINCT group_key) AS n FROM findings GROUP BY kind, severity`,
    )
    .all() as Array<{ kind: string; severity: string; n: number }>;

  const summary: FindingSummaryDto = { total: 0, high: 0, byKind: {} };
  for (const row of rows) {
    summary.total += row.n;
    if (row.severity === "high") summary.high += row.n;
    summary.byKind[row.kind] = (summary.byKind[row.kind] ?? 0) + row.n;
  }
  return summary;
}

/**
 * 从根到目标节点的展开链。
 *
 * 存在的理由：搜索和体检清单给出的都是深处的节点，而图只加载当前层。
 * 没有这条链，点击结果只能打开详情抽屉，图还停在原地——人得自己一层层
 * 下钻回去找，等于导航没接通。
 *
 * 返回的每一项都是可以直接交给 loadScope 的作用域 id，按从外到内排序。
 */
export function getRevealChain(db: Db, nodeId: string): string[] {
  const filePathOf = (id: number): string | null => {
    const row = db.prepare("SELECT path FROM files WHERE id = ?").get(id) as
      | { path: string }
      | undefined;
    return row?.path ?? null;
  };

  let leafPath: string | null = null;
  let leafScope: string | null = null;

  if (nodeId.startsWith("sym:")) {
    const row = db
      .prepare("SELECT file_id AS fileId FROM symbols WHERE id = ?")
      .get(Number(nodeId.slice(4))) as { fileId: number } | undefined;
    if (!row) return [];
    leafPath = filePathOf(row.fileId);
    leafScope = `file:${row.fileId}`;
  } else if (nodeId.startsWith("file:")) {
    leafPath = filePathOf(Number(nodeId.slice(5)));
    leafScope = nodeId;
  } else if (nodeId.startsWith("dir:")) {
    leafPath = nodeId.slice(4);
    leafScope = null;
  } else if (nodeId.startsWith("pkg:")) {
    // 包节点直接挂在根作用域上，没有中间层
    return [];
  } else {
    return [];
  }

  if (leafPath === null) return [];

  // 目录节点自己就是作用域，链子止于它的父目录；文件/符号的链子要包含所在目录
  const dirPath = leafScope === null ? dirOf(leafPath) : dirOf(leafPath);
  const segments = dirPath === "." ? [] : dirPath.split("/");

  // 落在哪个包里决定链子从哪儿起头：根视图画的是包，不是顶层目录
  const pkg = db
    .prepare(
      `SELECT name, dir FROM packages
       WHERE ? = dir OR ? LIKE dir || '/%'
       ORDER BY LENGTH(dir) DESC LIMIT 1`,
    )
    .get(dirPath, dirPath) as { name: string; dir: string } | undefined;

  const chain: string[] = [];
  let startIndex = 0;

  if (pkg) {
    chain.push(`pkg:${pkg.name}`);
    startIndex = pkg.dir === "." ? 0 : pkg.dir.split("/").length;
  }

  for (let i = startIndex; i < segments.length; i++) {
    chain.push(`dir:${segments.slice(0, i + 1).join("/")}`);
  }

  if (leafScope !== null && nodeId.startsWith("sym:")) chain.push(leafScope);

  return chain;
}
