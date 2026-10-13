import type { Db } from "./db/database.js";
import { commitCounts } from "./db/file-history.js";
import { inBatches, resolveScope, scopeFunctions } from "./db/scope.js";
import type { LensKind, LensValueDto } from "./types.js";

const MAX_NODES = 300;

/**
 * 图上叠加的一层视角，每个节点一组数：
 * - heat：近 90 天、近一年的提交数和 AI 参与次数（符号取所在文件）
 * - tests：范围里的函数有几个被测试用例走到
 */
export function getLens(db: Db, kind: LensKind, nodeIds: readonly string[]): Record<string, LensValueDto> {
  const out: Record<string, LensValueDto> = {};
  for (const id of nodeIds.slice(0, MAX_NODES)) {
    const scope = resolveScope(db, id);
    if (!scope) continue;
    if (kind === "heat") {
      const counts = commitCounts(db, scope.files);
      out[id] = { commits: counts?.commits ?? 0, recent: counts?.recent ?? 0, aiCommits: counts?.ai ?? 0 };
    } else {
      const functions = scopeFunctions(db, scope);
      const covered = inBatches(functions.map((f) => f.id), (batch) => db.prepare(
        `SELECT symbol_id AS id FROM test_coverage WHERE symbol_id IN (${batch.map(() => "?").join(",")})`,
      ).all(...batch) as Array<{ id: number }>).length;
      out[id] = { total: functions.length, covered };
    }
  }
  return out;
}
