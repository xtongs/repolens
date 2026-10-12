import type { Db } from "../db/database.js";

export interface TestCoverageStats {
  cases: number;
  /** 至少被一个用例走到的源码函数 */
  covered: number;
  /** 参与统计的源码函数 */
  functions: number;
}

/** 再往下走，「这个用例在测它」就只是一句空话了 */
const MAX_DEPTH = 4;
/** 一个用例最多记这么多个被测符号：集成测试一路能走到半个仓库 */
const MAX_REACH = 400;
const NEAREST = 6;

/**
 * 测试覆盖：每个测试用例沿确定/可能的调用往下走，记下走到的源码符号和层数。
 *
 * 这不是运行时覆盖率，是静态的「谁在测它」：读一个函数时先看哪几个用例直接调它、
 * 用例标题怎么写，那是人写下的行为说明，比 AI 摘要可信。中间穿过测试文件里的
 * 辅助函数照样算，只记源码里的落点。
 */
export function analyzeTests(db: Db): TestCoverageStats {
  db.exec("DELETE FROM test_coverage");
  const cases = (db.prepare("SELECT id FROM symbols WHERE test_kind = 'case'").all() as Array<{ id: number }>).map((row) => row.id);
  const functions = (db.prepare(
    `SELECT COUNT(*) AS n FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.role = 'source' AND s.kind IN ('function', 'method') AND s.implemented = 1`,
  ).get() as { n: number }).n;
  if (cases.length === 0) return { cases: 0, covered: 0, functions };

  const adjacency = new Map<number, number[]>();
  for (const edge of db.prepare(
    `SELECT src_id AS "from", dst_id AS "to" FROM edges
     WHERE type = 'calls' AND src_kind = 'symbol' AND dst_kind = 'symbol' AND confidence IN ('exact', 'likely')`,
  ).all() as Array<{ from: number; to: number }>) {
    const bucket = adjacency.get(edge.from);
    if (bucket) bucket.push(edge.to); else adjacency.set(edge.from, [edge.to]);
  }
  const source = new Set((db.prepare(
    "SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.role = 'source'",
  ).all() as Array<{ id: number }>).map((row) => row.id));

  const coverage = new Map<number, { tests: number; direct: number; nearest: Array<[number, number]> }>();
  for (const testId of cases) {
    const seen = new Set([testId]);
    let frontier = [testId];
    let reached = 0;
    for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0 && reached < MAX_REACH; depth++) {
      const next: number[] = [];
      for (const id of frontier) {
        for (const target of adjacency.get(id) ?? []) {
          if (seen.has(target)) continue;
          seen.add(target);
          next.push(target);
          if (!source.has(target)) continue;
          reached++;
          let entry = coverage.get(target);
          if (!entry) {
            entry = { tests: 0, direct: 0, nearest: [] };
            coverage.set(target, entry);
          }
          entry.tests++;
          if (depth === 1) entry.direct++;
          if (entry.nearest.length < NEAREST || depth < entry.nearest.at(-1)![1]) {
            entry.nearest.push([testId, depth]);
            entry.nearest.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
            if (entry.nearest.length > NEAREST) entry.nearest.pop();
          }
        }
      }
      frontier = next;
    }
  }

  const insert = db.prepare("INSERT INTO test_coverage (symbol_id, tests, direct, nearest) VALUES (?, ?, ?, ?)");
  for (const [symbolId, entry] of coverage) insert.run(symbolId, entry.tests, entry.direct, JSON.stringify(entry.nearest));

  const covered = (db.prepare(
    `SELECT COUNT(*) AS n FROM test_coverage t JOIN symbols s ON s.id = t.symbol_id
     WHERE s.kind IN ('function', 'method') AND s.implemented = 1`,
  ).get() as { n: number }).n;
  return { cases: cases.length, covered, functions };
}
