import picomatch from "picomatch";
import type { Db } from "../db/database.js";
import type { ArchitectureRule } from "../types.js";

export interface RuleViolation {
  fileId: number;
  filePath: string;
  line: number;
  /** 仓库内路径（文件或 Go 包目录）或外部包名 */
  target: string;
  targetFileId: number | null;
  typeOnly: boolean;
}

export interface RuleReport {
  rule: ArchitectureRule;
  label: string;
  /** from 命中的源码文件数；为 0 多半是 glob 写错了，规则等于没生效 */
  checkedFiles: number;
  violations: RuleViolation[];
}

interface ImportRow {
  fileId: number;
  filePath: string;
  line: number;
  typeOnly: number;
  targetFileId: number | null;
  targetPath: string | null;
  targetDir: string | null;
  externalName: string | null;
}

/**
 * 按仓库声明的依赖禁令逐条核对 import。
 *
 * 规则是人写下的意图，判据本身不会误报，能出错的只有 import 解析，所以只看
 * 解析到确定目标的 import：文件、Go 包目录、外部包名；未解析的一律不算。
 * 测试等非源码文件不受约束——测试跨层引用被测对象是常态。
 */
export function evaluateRules(db: Db, rules: readonly ArchitectureRule[]): RuleReport[] {
  if (rules.length === 0) return [];
  const sources = (db.prepare("SELECT path FROM files WHERE role = 'source'").all() as Array<{ path: string }>)
    .map((row) => row.path);
  const imports = db
    .prepare(
      `SELECT i.file_id AS fileId, sf.path AS filePath, i.line, i.is_type_only AS typeOnly,
              i.target_file_id AS targetFileId, tf.path AS targetPath,
              i.target_dir AS targetDir, i.external_name AS externalName
       FROM imports i
       JOIN files sf ON sf.id = i.file_id
       LEFT JOIN files tf ON tf.id = i.target_file_id
       WHERE sf.role = 'source' AND i.confidence IN ('exact', 'external')
       ORDER BY sf.path, i.line`,
    )
    .all() as ImportRow[];

  return rules.map((rule) => {
    const from = picomatch(rule.from, { dot: true });
    const disallowed = picomatch(rule.disallow, { dot: true });
    const allowed = rule.allow.length > 0 ? picomatch(rule.allow, { dot: true }) : () => false;

    const violations: RuleViolation[] = [];
    for (const row of imports) {
      if (row.typeOnly === 1 && !rule.includeTypeOnly) continue;
      if (!from(row.filePath)) continue;
      const target = row.targetPath ?? row.targetDir ?? row.externalName;
      if (target === null) continue;
      // Go 的包级 import 落在目录上，`internal/db/**` 这种写法要能罩住目录本身
      const probes = row.targetPath === null && row.targetDir !== null ? [target, `${target}/_`] : [target];
      if (!probes.some((probe) => disallowed(probe)) || probes.some((probe) => allowed(probe))) continue;
      violations.push({
        fileId: row.fileId,
        filePath: row.filePath,
        line: row.line,
        target,
        targetFileId: row.targetFileId,
        typeOnly: row.typeOnly === 1,
      });
    }

    return {
      rule,
      label: rule.name ?? `${rule.from.join(", ")} ↛ ${rule.disallow.join(", ")}`,
      checkedFiles: sources.filter((path) => from(path)).length,
      violations,
    };
  });
}
