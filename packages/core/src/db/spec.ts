import type { SpecCaseDto, SpecDto, TestCoverageDto, TestRefDto } from "../types.js";
import type { Db } from "./database.js";
import { inBatches, resolveScope, scopeFunctions } from "./scope.js";

/** 和链接阶段算覆盖的深度一致 */
const MAX_DEPTH = 4;
/** 反向扩散最多走这么多个函数：热点函数的调用方能有几百个 */
const MAX_VISITED = 20_000;

/** 走得到这些符号的测试用例（沿确定/可能的调用反向扩散） */
export function casesReaching(db: Db, symbolIds: readonly number[]): Map<number, number> {
  const found = new Map<number, number>();
  if (symbolIds.length === 0) return found;
  const callers = db.prepare(
    `SELECT e.src_id AS id, s.test_kind AS testKind FROM edges e JOIN symbols s ON s.id = e.src_id
     WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol'
       AND e.confidence IN ('exact', 'likely') AND e.dst_id = ?`,
  );
  const seen = new Set(symbolIds);
  let frontier = [...symbolIds];
  for (let depth = 1; depth <= MAX_DEPTH && frontier.length > 0 && seen.size < MAX_VISITED; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const row of callers.all(id) as Array<{ id: number; testKind: string | null }>) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        if (row.testKind === "case") found.set(row.id, depth);
        else next.push(row.id);
      }
    }
    frontier = next;
  }
  return found;
}

/** 一个符号的测试覆盖：用例数和离它最近的几个用例 */
export function testCoverageOf(db: Db, symbolId: number): TestCoverageDto | null {
  const row = db.prepare("SELECT tests, direct, nearest FROM test_coverage WHERE symbol_id = ?").get(symbolId) as
    | { tests: number; direct: number; nearest: string } | undefined;
  if (!row) return null;
  return { total: row.tests, direct: row.direct, nearest: testRefs(db, parsePairs(row.nearest)) };
}

/** 用例符号 → 用例条目，带上外层用例组的标题 */
export function testRefs(db: Db, pairs: ReadonlyArray<[number, number]>): TestRefDto[] {
  if (pairs.length === 0) return [];
  const symbol = db.prepare(
    `SELECT s.id, s.name, s.start_line AS line, s.start_byte AS startByte, s.end_byte AS endByte, s.file_id AS fileId, f.path
     FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
  );
  return pairs.flatMap(([id, depth]) => {
    const row = symbol.get(id) as { id: number; name: string; line: number; startByte: number; endByte: number; fileId: number; path: string } | undefined;
    if (!row) return [];
    return [{ id: `sym:${row.id}`, name: row.name, suite: suiteOf(db, row.fileId, row.startByte, row.endByte), path: row.path, line: row.line, depth }];
  });
}

/** 罩住这个用例的用例组，由外向内用 › 连起来 */
function suiteOf(db: Db, fileId: number, startByte: number, endByte: number): string | null {
  const suites = db.prepare(
    `SELECT name FROM symbols WHERE file_id = ? AND test_kind = 'suite'
       AND start_byte <= ? AND end_byte >= ? ORDER BY start_byte`,
  ).all(fileId, startByte, endByte) as Array<{ name: string }>;
  return suites.length > 0 ? suites.map((s) => s.name).join(" › ") : null;
}

/**
 * 一块代码的行为规格：离它里面的函数最近的那些用例，按测试文件和用例组归好。
 * 用例标题是人写下的「它应该怎样」，比 AI 摘要可信；读一个模块前先扫一眼这里。
 */
export function getSpec(db: Db, nodeId: string): SpecDto | null {
  const scope = resolveScope(db, nodeId);
  if (!scope) return null;
  const functions = scope.symbolId !== null
    ? [{ id: scope.symbolId }]
    : [...scopeFunctions(db, scope), ...classesIn(db, scope.files)];
  const names = new Map<number, string>();
  const nameOf = db.prepare("SELECT name, container FROM symbols WHERE id = ?");
  const cases = new Map<number, { depth: number; targets: Set<string> }>();
  const coverage = inBatches(functions.map((f) => f.id), (batch) => db.prepare(
    `SELECT symbol_id AS id, nearest FROM test_coverage WHERE symbol_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; nearest: string }>);
  for (const row of coverage) {
    if (!names.has(row.id)) {
      const symbol = nameOf.get(row.id) as { name: string; container: string | null } | undefined;
      names.set(row.id, symbol ? (symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name) : "?");
    }
    for (const [caseId, depth] of parsePairs(row.nearest)) {
      const entry = cases.get(caseId) ?? { depth, targets: new Set<string>() };
      entry.depth = Math.min(entry.depth, depth);
      entry.targets.add(names.get(row.id)!);
      cases.set(caseId, entry);
    }
  }

  const refs = testRefs(db, [...cases].map(([id, entry]) => [id, entry.depth] as [number, number]));
  const files = new Map<string, Map<string | null, SpecCaseDto[]>>();
  const fileIds = new Map<string, string>();
  const fileIdOf = db.prepare("SELECT f.id FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?");
  for (const ref of refs) {
    const suites = files.get(ref.path) ?? new Map<string | null, SpecCaseDto[]>();
    files.set(ref.path, suites);
    if (!fileIds.has(ref.path)) fileIds.set(ref.path, `file:${(fileIdOf.get(Number(ref.id.slice(4))) as { id: number }).id}`);
    const list = suites.get(ref.suite) ?? [];
    list.push({ id: ref.id, name: ref.name, line: ref.line, depth: ref.depth, targets: [...cases.get(Number(ref.id.slice(4)))!.targets].slice(0, 4) });
    suites.set(ref.suite, list);
  }
  return {
    cases: refs.length,
    files: [...files]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([path, suites]) => ({
        id: fileIds.get(path)!,
        path,
        suites: [...suites]
          .map(([name, list]) => ({ name, cases: list.sort((a, b) => a.line - b.line) }))
          .sort((a, b) => (a.cases[0]?.line ?? 0) - (b.cases[0]?.line ?? 0)),
      })),
  };
}

function classesIn(db: Db, files: ReadonlySet<number>): Array<{ id: number }> {
  return inBatches([...files], (batch) => db.prepare(
    `SELECT id FROM symbols WHERE kind IN ('class', 'struct') AND file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number }>);
}

function parsePairs(raw: string): Array<[number, number]> {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value)
      ? value.filter((pair): pair is [number, number] => Array.isArray(pair) && Number.isInteger(pair[0]) && Number.isInteger(pair[1]))
      : [];
  } catch {
    return [];
  }
}
