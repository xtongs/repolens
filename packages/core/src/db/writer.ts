import type {
  Confidence,
  DiscoveredPackage,
  EdgeType,
  ParsedExport,
  ParsedSymbol,
  SymbolKind,
} from "../types.js";
import { baseName, depthOf, dirOf } from "../resolve/path-utils.js";
import type { Db } from "./database.js";

export interface FileRow {
  path: string;
  language: string;
  role: string;
  bytes: number;
  hash: string;
  loc: number;
  packageDir: string | null;
}

export interface FindingRow {
  kind: "duplicate" | "cycle";
  severity: "high" | "medium" | "low";
  scopeKind: "package" | "directory" | "file" | "symbol";
  /** 图节点 id */
  scopeKey: string;
  /** 仓库相对路径，供上层节点前缀汇总 */
  path: string;
  title: string;
  detail: string;
  related: string[];
  groupKey: string;
}

export interface ImportRow {
  rawSource: string;
  kind: string;
  confidence: Confidence;
  targetFileId: number | null;
  targetDir: string | null;
  externalName: string | null;
  unresolvedReason: string | null;
  isTypeOnly: boolean;
  line: number;
  specifiers: Array<{
    imported: string;
    local: string;
    isDefault: boolean;
    isNamespace: boolean;
  }>;
}

export interface CallSiteRow {
  callerSymbolId: number | null;
  calleeName: string;
  receiver: string | null;
  calleePath: string | null;
  callKind: string;
  argCount: number;
  line: number;
}

export interface EdgeRow {
  type: EdgeType;
  srcKind: "file" | "symbol";
  srcId: number;
  dstKind: "file" | "symbol" | "external";
  dstId: number | null;
  dstName: string | null;
  confidence: Confidence;
  line: number | null;
  callKind: string | null;
  candidates: number[] | null;
  weight: number;
}

export interface RollupEdgeRow {
  level: "package" | "directory";
  type: EdgeType;
  src: string;
  dst: string;
  confidence: Confidence;
  count: number;
  weight: number;
}

export interface TypeRelationRow {
  subjectId: number | null;
  subject: string;
  relation: "extends" | "implements" | "embeds";
  target: string;
  targetId: number | null;
  confidence: Confidence;
  line: number;
}

export interface SearchRow {
  label: string;
  detail: string;
  kind: string;
  ref: string;
  /** 文件角色，用于让搜索遵守和图谱一致的噪音过滤 */
  role: string;
}

/**
 * 批量写入层。
 *
 * 所有语句预编译一次复用——在 40 万行仓库上有几十万次插入，
 * 每次重新编译 SQL 的开销会主导整个扫描耗时。
 */
export class IndexWriter {
  private readonly stmts;

  constructor(private readonly db: Db) {
    this.stmts = {
      insertPackage: db.prepare(
        `INSERT INTO packages (name, dir, manager, version, entry_points)
         VALUES (@name, @dir, @manager, @version, @entryPoints)
         ON CONFLICT(dir) DO UPDATE SET
           name = excluded.name, manager = excluded.manager,
           version = excluded.version, entry_points = excluded.entry_points`,
      ),
      insertDirectory: db.prepare(
        `INSERT INTO directories (path, parent_path, name, depth, package_id)
         VALUES (@path, @parentPath, @name, @depth, @packageId)
         ON CONFLICT(path) DO UPDATE SET
           parent_path = excluded.parent_path, package_id = excluded.package_id`,
      ),
      insertFile: db.prepare(
        `INSERT INTO files (path, dir_path, name, language, role, package_id, loc, bytes, hash, parsed, parse_error, complexity)
         VALUES (@path, @dirPath, @name, @language, @role, @packageId, @loc, @bytes, @hash, 0, NULL, 0)
         ON CONFLICT(path) DO UPDATE SET
           language = excluded.language, role = excluded.role, package_id = excluded.package_id,
           loc = excluded.loc, bytes = excluded.bytes, hash = excluded.hash,
           parsed = 0, parse_error = NULL, complexity = 0`,
      ),
      fileId: db.prepare("SELECT id FROM files WHERE path = ?"),
      deleteFile: db.prepare("DELETE FROM files WHERE path = ?"),
      deleteFileSummary: db.prepare(
        "DELETE FROM summaries WHERE target_kind = 'file' AND target_key = ?",
      ),
      markParsed: db.prepare(
        "UPDATE files SET parsed = 1, parse_error = @error, complexity = @complexity WHERE id = @id",
      ),
      clearSymbols: db.prepare("DELETE FROM symbols WHERE file_id = ?"),
      clearImports: db.prepare("DELETE FROM imports WHERE file_id = ?"),
      clearExports: db.prepare("DELETE FROM exports WHERE file_id = ?"),
      clearCallSites: db.prepare("DELETE FROM call_sites WHERE file_id = ?"),
      clearTypeRelations: db.prepare("DELETE FROM type_relations WHERE file_id = ?"),
      insertSymbol: db.prepare(
        `INSERT INTO symbols
           (file_id, name, kind, container, exported, signature, params, return_type, doc,
            start_line, end_line, start_byte, end_byte, complexity, is_async, is_static, receiver_type, hash, shape)
         VALUES
           (@fileId, @name, @kind, @container, @exported, @signature, @params, @returnType, @doc,
            @startLine, @endLine, @startByte, @endByte, @complexity, @isAsync, @isStatic, @receiverType, @hash, @shape)`,
      ),
      insertImport: db.prepare(
        `INSERT INTO imports
           (file_id, raw_source, kind, confidence, target_file_id, target_dir, external_name,
            unresolved_reason, is_type_only, line)
         VALUES
           (@fileId, @rawSource, @kind, @confidence, @targetFileId, @targetDir, @externalName,
            @unresolvedReason, @isTypeOnly, @line)`,
      ),
      insertImportSpec: db.prepare(
        `INSERT INTO import_specifiers (import_id, imported, local, is_default, is_namespace)
         VALUES (@importId, @imported, @local, @isDefault, @isNamespace)`,
      ),
      insertExport: db.prepare(
        `INSERT INTO exports (file_id, name, kind, source, symbol_id, line)
         VALUES (@fileId, @name, @kind, @source, @symbolId, @line)`,
      ),
      insertFinding: db.prepare(
        `INSERT INTO findings (kind, severity, scope_kind, scope_key, path, title, detail, related, group_key)
         VALUES (@kind, @severity, @scopeKind, @scopeKey, @path, @title, @detail, @related, @groupKey)`,
      ),
      insertCallSite: db.prepare(
        `INSERT INTO call_sites
           (file_id, caller_symbol_id, callee_name, receiver, callee_path, call_kind, arg_count, line)
         VALUES
           (@fileId, @callerSymbolId, @calleeName, @receiver, @calleePath, @callKind, @argCount, @line)`,
      ),
      insertTypeRelation: db.prepare(
        `INSERT INTO type_relations
           (file_id, subject_id, subject, relation, target, target_id, confidence, line)
         VALUES
           (@fileId, @subjectId, @subject, @relation, @target, @targetId, @confidence, @line)`,
      ),
      insertEdge: db.prepare(
        `INSERT INTO edges
           (type, src_kind, src_id, dst_kind, dst_id, dst_name, confidence, line, call_kind, candidates, weight)
         VALUES
           (@type, @srcKind, @srcId, @dstKind, @dstId, @dstName, @confidence, @line, @callKind, @candidates, @weight)`,
      ),
      insertRollup: db.prepare(
        `INSERT INTO rollup_edges (level, type, src, dst, confidence, count, weight)
         VALUES (@level, @type, @src, @dst, @confidence, @count, @weight)
         ON CONFLICT(level, type, src, dst, confidence) DO UPDATE SET
           count = count + excluded.count, weight = weight + excluded.weight`,
      ),
      insertSearch: db.prepare(
        "INSERT INTO search_index (label, detail, kind, ref, role) VALUES (@label, @detail, @kind, @ref, @role)",
      ),
      deleteStaleFileSummary: db.prepare(
        "DELETE FROM summaries WHERE target_kind = 'file' AND target_key = @path AND source_hash != @hash",
      ),
      deleteSymbolSummariesForFile: db.prepare(
        `DELETE FROM summaries WHERE target_kind = 'symbol'
         AND substr(target_key, 1, length(@prefix)) = @prefix`,
      ),
    };
  }

  // -------------------------------------------------------------------------
  // 骨架
  // -------------------------------------------------------------------------

  /**
   * 同步包表，返回包目录到 id 的映射，以及包集合是否发生了变化。
   *
   * 这里刻意不用「先清空再重建」：files.package_id 是 ON DELETE SET NULL
   * 的外键，清空一次就会抹掉全仓库文件的包归属，而增量扫描只会重写
   * 变更的那几个文件，其余文件从此永久失去归属。
   */
  syncPackages(packages: readonly DiscoveredPackage[]): {
    byDir: Map<string, number>;
    changed: boolean;
  } {
    const before = new Set(
      (this.db.prepare("SELECT dir FROM packages").all() as Array<{ dir: string }>).map(
        (r) => r.dir,
      ),
    );

    for (const pkg of packages) {
      this.stmts.insertPackage.run({
        name: pkg.name,
        dir: pkg.dir,
        manager: pkg.manager,
        version: pkg.version ?? null,
        entryPoints: JSON.stringify(pkg.entryPoints),
      });
    }

    const keep = new Set(packages.map((p) => p.dir));
    const removeStale = this.db.prepare("DELETE FROM packages WHERE dir = ?");
    let removed = 0;
    for (const dir of before) {
      if (keep.has(dir)) continue;
      removeStale.run(dir);
      removed++;
    }

    const rows = this.db.prepare("SELECT id, dir FROM packages").all() as Array<{
      id: number;
      dir: string;
    }>;
    return {
      byDir: new Map(rows.map((r) => [r.dir, r.id])),
      changed: removed > 0 || packages.some((p) => !before.has(p.dir)),
    };
  }

  /**
   * 按路径前缀重算所有文件的包归属。
   *
   * 归属完全由路径决定，所以这是一次可重复的对账，只在包集合变动时
   * 才有必要跑。用 substr 而不是 LIKE：包目录名里的下划线会被 LIKE
   * 当成通配符，`a_b` 会错配到 `axb/`。
   */
  reassignFilePackages(): void {
    this.db.exec(`
      UPDATE files SET package_id = (
        SELECT p.id FROM packages p
        WHERE p.dir = '.'
           OR substr(files.path, 1, length(p.dir) + 1) = p.dir || '/'
        ORDER BY length(p.dir) DESC
        LIMIT 1
      )
    `);
  }

  syncDirectories(dirs: readonly string[], packageIdByDir: ReadonlyMap<string, number>): void {
    this.db.exec("DELETE FROM directories");
    const sorted = [...dirs].sort();
    for (const path of sorted) {
      this.stmts.insertDirectory.run({
        path,
        parentPath: dirOf(path) === path ? null : dirOf(path),
        name: baseName(path),
        depth: depthOf(path),
        packageId: nearestPackageId(path, packageIdByDir),
      });
    }
  }

  upsertFile(file: FileRow, packageIdByDir: ReadonlyMap<string, number>): number {
    this.stmts.insertFile.run({
      path: file.path,
      dirPath: dirOf(file.path),
      name: baseName(file.path),
      language: file.language,
      role: file.role,
      packageId:
        file.packageDir !== null ? (packageIdByDir.get(file.packageDir) ?? null) : null,
      loc: file.loc,
      bytes: file.bytes,
      hash: file.hash,
    });
    this.stmts.deleteStaleFileSummary.run({ path: file.path, hash: file.hash });
    // upsertFile 只会处理新增或内容/分类发生变化的文件。符号 id、行号和
    // 重载集合都可能改变，重解析前清掉该文件的符号语义比误配给同名函数安全。
    this.stmts.deleteSymbolSummariesForFile.run({ prefix: `${file.path}#` });
    const row = this.stmts.fileId.get(file.path) as { id: number } | undefined;
    if (!row) throw new Error(`文件写入后未能读回 id：${file.path}`);
    return row.id;
  }

  deleteFile(path: string): void {
    this.stmts.deleteFileSummary.run(path);
    this.stmts.deleteSymbolSummariesForFile.run({ prefix: `${path}#` });
    this.stmts.deleteFile.run(path);
  }

  /** 清空某文件的全部解析产物，供重新解析前调用 */
  clearFileArtifacts(fileId: number): void {
    this.stmts.clearCallSites.run(fileId);
    this.stmts.clearTypeRelations.run(fileId);
    this.stmts.clearExports.run(fileId);
    this.stmts.clearImports.run(fileId);
    this.stmts.clearSymbols.run(fileId);
  }

  markParsed(fileId: number, complexity: number, error: string | null): void {
    this.stmts.markParsed.run({ id: fileId, complexity, error });
  }

  // -------------------------------------------------------------------------
  // 解析产物
  // -------------------------------------------------------------------------

  /** 返回与入参同序的符号 id 数组 */
  insertSymbols(fileId: number, symbols: readonly ParsedSymbol[], hashes: readonly string[]): number[] {
    const ids: number[] = [];
    for (const [i, sym] of symbols.entries()) {
      const info = this.stmts.insertSymbol.run({
        fileId,
        name: sym.name,
        kind: sym.kind,
        container: sym.container ?? null,
        exported: sym.exported ? 1 : 0,
        signature: sym.signature ?? null,
        params: sym.params ? JSON.stringify(sym.params) : null,
        returnType: sym.returnType ?? null,
        doc: sym.doc ?? null,
        startLine: sym.startLine,
        endLine: sym.endLine,
        startByte: sym.startByte,
        endByte: sym.endByte,
        complexity: sym.complexity,
        isAsync: sym.isAsync ? 1 : 0,
        isStatic: sym.isStatic ? 1 : 0,
        receiverType: sym.receiverType ?? null,
        hash: hashes[i] ?? "",
        shape: sym.shape ?? null,
      });
      ids.push(Number(info.lastInsertRowid));
    }
    return ids;
  }

  insertImports(fileId: number, imports: readonly ImportRow[]): void {
    for (const imp of imports) {
      const info = this.stmts.insertImport.run({
        fileId,
        rawSource: imp.rawSource,
        kind: imp.kind,
        confidence: imp.confidence,
        targetFileId: imp.targetFileId,
        targetDir: imp.targetDir,
        externalName: imp.externalName,
        unresolvedReason: imp.unresolvedReason,
        isTypeOnly: imp.isTypeOnly ? 1 : 0,
        line: imp.line,
      });
      const importId = Number(info.lastInsertRowid);
      for (const spec of imp.specifiers) {
        this.stmts.insertImportSpec.run({
          importId,
          imported: spec.imported,
          local: spec.local,
          isDefault: spec.isDefault ? 1 : 0,
          isNamespace: spec.isNamespace ? 1 : 0,
        });
      }
    }
  }

  insertExports(
    fileId: number,
    exportsList: readonly ParsedExport[],
    symbolIdByName: ReadonlyMap<string, number>,
  ): void {
    for (const exp of exportsList) {
      this.stmts.insertExport.run({
        fileId,
        name: exp.name,
        kind: exp.kind,
        source: exp.source ?? null,
        symbolId: symbolIdByName.get(exp.name) ?? null,
        line: exp.line,
      });
    }
  }

  insertCallSites(fileId: number, sites: readonly CallSiteRow[]): void {
    for (const site of sites) {
      this.stmts.insertCallSite.run({
        fileId,
        callerSymbolId: site.callerSymbolId,
        calleeName: site.calleeName,
        receiver: site.receiver,
        calleePath: site.calleePath,
        callKind: site.callKind,
        argCount: site.argCount,
        line: site.line,
      });
    }
  }

  insertTypeRelations(fileId: number, relations: readonly TypeRelationRow[]): void {
    for (const rel of relations) {
      this.stmts.insertTypeRelation.run({
        fileId,
        subjectId: rel.subjectId,
        subject: rel.subject,
        relation: rel.relation,
        target: rel.target,
        targetId: rel.targetId,
        confidence: rel.confidence,
        line: rel.line,
      });
    }
  }

  // -------------------------------------------------------------------------
  // 派生数据
  // -------------------------------------------------------------------------

  /** 边、聚合边和体检结论都是全局派生的，每次链接前整表清空重算 */
  clearDerived(): void {
    this.db.exec(
      "DELETE FROM edges; DELETE FROM rollup_edges; DELETE FROM search_index; DELETE FROM findings",
    );
  }

  insertFindings(findings: readonly FindingRow[]): void {
    for (const f of findings) {
      this.stmts.insertFinding.run({
        kind: f.kind,
        severity: f.severity,
        scopeKind: f.scopeKind,
        scopeKey: f.scopeKey,
        path: f.path,
        title: f.title,
        detail: f.detail,
        related: JSON.stringify(f.related),
        groupKey: f.groupKey,
      });
    }
  }

  insertEdges(edges: readonly EdgeRow[]): void {
    for (const edge of edges) {
      this.stmts.insertEdge.run({
        type: edge.type,
        srcKind: edge.srcKind,
        srcId: edge.srcId,
        dstKind: edge.dstKind,
        dstId: edge.dstId,
        dstName: edge.dstName,
        confidence: edge.confidence,
        line: edge.line,
        callKind: edge.callKind,
        candidates: edge.candidates ? JSON.stringify(edge.candidates) : null,
        weight: edge.weight,
      });
    }
  }

  insertRollupEdges(edges: readonly RollupEdgeRow[]): void {
    for (const edge of edges) {
      this.stmts.insertRollup.run(edge);
    }
  }

  insertSearchRows(rows: readonly SearchRow[]): void {
    for (const row of rows) this.stmts.insertSearch.run(row);
  }

  /**
   * 把文件级指标向上累加到目录。
   *
   * 用一次性的 SQL 递归而不是在 JS 里建树：目录数量可能上千，
   * 而这个计算本质上就是按路径前缀分组求和，交给 SQLite 更快也更简单。
   */
  rollupDirectoryMetrics(): void {
    this.db.exec(`
      UPDATE directories SET
        loc = COALESCE((
          SELECT SUM(f.loc) FROM files f
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0),
        file_count = COALESCE((
          SELECT COUNT(*) FROM files f
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0),
        complexity = COALESCE((
          SELECT SUM(f.complexity) FROM files f
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0),
        symbol_count = COALESCE((
          SELECT COUNT(*) FROM symbols s
          JOIN files f ON f.id = s.file_id
          WHERE f.path LIKE directories.path || '/%' OR f.dir_path = directories.path
        ), 0)
    `);
  }
}

function nearestPackageId(
  dirPath: string,
  packageIdByDir: ReadonlyMap<string, number>,
): number | null {
  let candidate: string | null = dirPath;
  while (candidate !== null) {
    const id = packageIdByDir.get(candidate);
    if (id !== undefined) return id;
    const parent = dirOf(candidate);
    candidate = parent === candidate ? null : parent;
    if (candidate === ".") {
      return packageIdByDir.get(".") ?? null;
    }
  }
  return null;
}

export type { SymbolKind };
