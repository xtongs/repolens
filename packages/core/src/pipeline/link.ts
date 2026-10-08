import type { Db } from "../db/database.js";
import type { EdgeRow, IndexWriter, RollupEdgeRow, SearchRow } from "../db/writer.js";
import { dirOf } from "../resolve/path-utils.js";
import type { ArchitectureRule, Confidence, HttpLinkStats } from "../types.js";
import { type DiagnoseStats, diagnose } from "./diagnose.js";
import { linkHttpEdges } from "./http-links.js";
import { linkCallEdges } from "./link-calls.js";
import { analyzeTraces, type TraceAnalysisStats } from "./trace.js";

export interface LinkStats {
  calls: number;
  callsByConfidence: Record<Confidence, number>;
  findings: DiagnoseStats;
  traces: TraceAnalysisStats;
  http: HttpLinkStats;
}

/**
 * 链接阶段：把入库的原始事实变成图。
 *
 * 整体重算而不是增量更新，因为一条 import 的变化可能影响任意远处的边——
 * 增量地维护正确性远比重算一次贵。重算的输入全在 SQLite 里，
 * 不需要重新解析源码，40 万行规模下是秒级操作。
 */
export function linkGraph(db: Db, writer: IndexWriter, rules: readonly ArchitectureRule[] = []): LinkStats {
  writer.clearDerived();

  linkImportEdges(db, writer);
  const calls = linkCallEdges(db, (edges) => writer.insertEdges(edges));
  linkTypeRelations(db);
  const traces = analyzeTraces(db);
  // 路由表来自入口识别，所以排在链路分析之后；链路因此也不会跨过网络边界
  const http = linkHttpEdges(db, writer);
  buildSearchIndex(db, writer);
  // 体检要在 rollup 边建好之后跑，环检测读的就是那张表
  const findings = diagnose(db, writer, rules);

  return { calls: calls.callSites, callsByConfidence: calls.byConfidence, findings, traces, http };
}

// ---------------------------------------------------------------------------
// import 边
// ---------------------------------------------------------------------------

interface ImportEdgeSource {
  fileId: number;
  filePath: string;
  filePackage: string | null;
  targetFileId: number | null;
  targetPath: string | null;
  targetPackage: string | null;
  targetDir: string | null;
  externalName: string | null;
  confidence: Confidence;
  isTypeOnly: number;
  fileRole: string;
  targetRole: string | null;
}

function linkImportEdges(db: Db, writer: IndexWriter): void {
  const rows = db
    .prepare(
      `SELECT
         i.file_id        AS fileId,
         sf.path          AS filePath,
         sf.role          AS fileRole,
         tf.role          AS targetRole,
         sp.name          AS filePackage,
         i.target_file_id AS targetFileId,
         tf.path          AS targetPath,
         tp.name          AS targetPackage,
         i.target_dir     AS targetDir,
         i.external_name  AS externalName,
         i.confidence     AS confidence,
         i.is_type_only   AS isTypeOnly
       FROM imports i
       JOIN files sf ON sf.id = i.file_id
       LEFT JOIN packages sp ON sp.id = sf.package_id
       LEFT JOIN files tf ON tf.id = i.target_file_id
       LEFT JOIN packages tp ON tp.id = tf.package_id`,
    )
    .all() as ImportEdgeSource[];

  // 同一对文件之间的多条 import 合并成一条边，权重记次数
  const fileEdges = new Map<string, EdgeRow>();
  const externalEdges = new Map<string, EdgeRow>();
  const dirRollup = new Map<string, RollupEdgeRow>();
  const pkgRollup = new Map<string, RollupEdgeRow>();

  // `import type` 只在编译期存在，记成 references 而不是 imports：
  // 前端只 import 后端的类型时，架构图上不该出现一条运行时依赖，
  // 循环检测也不该把「互相引用类型」报成模块环。
  const bumpRollup = (
    store: Map<string, RollupEdgeRow>,
    level: "directory" | "package",
    src: string,
    dst: string,
    typeOnly: boolean,
  ) => {
    if (src === dst) return;
    const type = typeOnly ? "references" : "imports";
    const key = `${src}\u0000${dst}\u0000${type}`;
    const existing = store.get(key);
    if (existing) {
      existing.count++;
      existing.weight++;
      return;
    }
    store.set(key, { level, type, src, dst, confidence: "exact", count: 1, weight: 1 });
  };

  for (const row of rows) {
    const typeOnly = row.isTypeOnly === 1;
    if (row.targetFileId !== null && row.targetPath !== null) {
      const key = `${row.fileId}->${row.targetFileId}`;
      const existing = fileEdges.get(key);
      if (existing) {
        existing.weight++;
        if (!typeOnly) existing.type = "imports";
      } else {
        fileEdges.set(key, {
          type: typeOnly ? "references" : "imports",
          srcKind: "file",
          srcId: row.fileId,
          dstKind: "file",
          dstId: row.targetFileId,
          dstName: null,
          confidence: "exact",
          line: null,
          callKind: null,
          candidates: null,
          weight: 1,
        });
      }
      // 目录/包之间的边讲的是产品代码的架构：测试和脚本 import 被测模块，
      // 会让架构图多出反向边、让循环检测报出不存在的模块环
      if (row.fileRole === "source" && row.targetRole === "source") {
        bumpRollup(dirRollup, "directory", dirOf(row.filePath), dirOf(row.targetPath), typeOnly);
        if (row.filePackage !== null && row.targetPackage !== null) {
          bumpRollup(pkgRollup, "package", row.filePackage, row.targetPackage, typeOnly);
        }
      }
      continue;
    }

    if (row.targetDir !== null) {
      // Go 的 import 是包级的，落在目录上；不展开成对每个文件的边，
      // 否则一个 import 会凭空产生该包文件数那么多条边。
      if (row.fileRole === "source") bumpRollup(dirRollup, "directory", dirOf(row.filePath), row.targetDir, typeOnly);
      continue;
    }

    if (row.externalName !== null) {
      const key = `${row.fileId}->ext:${row.externalName}`;
      const existing = externalEdges.get(key);
      if (existing) {
        existing.weight++;
        continue;
      }
      externalEdges.set(key, {
        type: "imports",
        srcKind: "file",
        srcId: row.fileId,
        dstKind: "external",
        dstId: null,
        dstName: row.externalName,
        confidence: "external",
        line: null,
        callKind: null,
        candidates: null,
        weight: 1,
      });
    }
  }

  writer.insertEdges([...fileEdges.values(), ...externalEdges.values()]);
  writer.insertRollupEdges([...dirRollup.values(), ...pkgRollup.values()]);
}

// ---------------------------------------------------------------------------
// 类型关系
// ---------------------------------------------------------------------------

/**
 * 把 `extends` / `implements` / `embeds` 的目标名解析到具体符号。
 *
 * 这里用的是全局导出符号名匹配，不追 import 链：类型名在一个仓库里
 * 撞名的概率远低于函数名，而且候选不唯一时会降级成 ambiguous，
 * 不会产生一条看起来确定的错边。
 */
function linkTypeRelations(db: Db): void {
  const typeSymbols = db
    .prepare(
      `SELECT id, name FROM symbols
       WHERE kind IN ('class', 'interface', 'struct', 'trait', 'type', 'enum')`,
    )
    .all() as Array<{ id: number; name: string }>;

  const byName = new Map<string, number[]>();
  for (const sym of typeSymbols) {
    const bucket = byName.get(sym.name);
    if (bucket) bucket.push(sym.id);
    else byName.set(sym.name, [sym.id]);
  }

  const update = db.prepare(
    "UPDATE type_relations SET target_id = @targetId, confidence = @confidence WHERE id = @id",
  );
  const relations = db
    .prepare("SELECT id, target FROM type_relations")
    .all() as Array<{ id: number; target: string }>;

  for (const rel of relations) {
    const candidates = byName.get(rel.target);
    if (!candidates || candidates.length === 0) {
      update.run({ id: rel.id, targetId: null, confidence: "external" });
      continue;
    }
    if (candidates.length === 1) {
      update.run({ id: rel.id, targetId: candidates[0], confidence: "likely" });
      continue;
    }
    update.run({ id: rel.id, targetId: candidates[0], confidence: "ambiguous" });
  }
}

// ---------------------------------------------------------------------------
// 搜索索引
// ---------------------------------------------------------------------------

function buildSearchIndex(db: Db, writer: IndexWriter): void {
  const rows: SearchRow[] = [];

  // 包和目录没有「角色」，一律当 source：它们是结构而不是内容，
  // 不该因为噪音开关而从搜索里消失
  for (const pkg of db.prepare("SELECT name, dir FROM packages").all() as Array<{
    name: string;
    dir: string;
  }>) {
    rows.push({
      label: pkg.name,
      detail: pkg.dir,
      kind: "package",
      ref: `pkg:${pkg.name}`,
      role: "source",
    });
  }

  for (const dir of db
    .prepare("SELECT path, name FROM directories WHERE file_count > 0")
    .all() as Array<{ path: string; name: string }>) {
    rows.push({
      label: dir.name,
      detail: dir.path,
      kind: "directory",
      ref: `dir:${dir.path}`,
      role: "source",
    });
  }

  for (const file of db.prepare("SELECT id, path, name, role FROM files").all() as Array<{
    id: number;
    path: string;
    name: string;
    role: string;
  }>) {
    rows.push({
      label: file.name,
      detail: file.path,
      kind: "file",
      ref: `file:${file.id}`,
      role: file.role,
    });
  }

  for (const sym of db
    .prepare(
      `SELECT s.id, s.name, s.kind, s.container, f.path, f.role
       FROM symbols s JOIN files f ON f.id = s.file_id`,
    )
    .all() as Array<{
    id: number;
    name: string;
    kind: string;
    container: string | null;
    path: string;
    role: string;
  }>) {
    const qualified = sym.container !== null ? `${sym.container}.${sym.name}` : sym.name;
    rows.push({
      label: qualified,
      detail: `${sym.kind} · ${sym.path}`,
      kind: "symbol",
      ref: `sym:${sym.id}`,
      role: sym.role,
    });
  }

  writer.insertSearchRows(rows);
}
