import type { Db } from "../db/database.js";
import type { FindingRow, IndexWriter } from "../db/writer.js";

/**
 * 架构体检：从已链接的图里找出结构上可疑的地方。
 *
 * 这一层的全部价值在于节省人的注意力，所以判据一律「宁可漏报不可误报」。
 * 一个会乱叫的诊断比没有诊断更糟——它消耗的正是它本该节省的那样东西，
 * 而且只要错过一次，人就再也不会认真看第二次。
 *
 * 因此每条判据都写成「排除掉所有我能想到的正常情况之后还剩下的」，
 * 而不是「符合某个模式的」。下面每个检测器的注释里都记了它排除了什么、
 * 以及不排除的话在真实仓库上会误报多少。
 *
 * 全部是确定性判断，不需要 LLM。
 */

export interface DiagnoseStats {
  duplicate: number;
  cycle: number;
}

export function diagnose(db: Db, writer: IndexWriter): DiagnoseStats {
  const findings: FindingRow[] = [];

  const duplicate = detectDuplicates(db, findings);
  const cycle = detectCycles(db, findings);

  writer.insertFindings(findings);
  return { duplicate, cycle };
}

// ---------------------------------------------------------------------------
// 重复实现
// ---------------------------------------------------------------------------

/**
 * 形状指纹相同、但分散在不同文件里的函数。
 *
 * 这是 AI 参与写码之后最常见的结构问题：同一段逻辑按语言、按场景各生成
 * 一遍，而不是抽出共用。人写码时的复制粘贴也会落进这里。
 *
 * 判据依次排除：
 * - 只在同一个文件里出现的组——那是重载或局部辅助，不构成跨文件重复
 * - 太小的函数——`return x.length` 这种形状撞车毫无意义，实测不设下限时
 *   一个中型仓库会报出几百组单行 getter
 * - 非源码角色的文件——测试里的 setup 函数长得一样是应该的
 */
const MIN_DUPLICATE_COMPLEXITY = 2;
const MIN_DUPLICATE_LINES = 3;

function detectDuplicates(db: Db, out: FindingRow[]): number {
  const rows = db
    .prepare(
      `SELECT s.shape, s.id, s.name, s.container, s.complexity,
              (s.end_line - s.start_line + 1) AS lines,
              f.path, f.id AS fileId
       FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE s.shape IS NOT NULL
         AND f.role = 'source'
         AND s.kind IN ('function', 'method')
         AND s.complexity >= ${MIN_DUPLICATE_COMPLEXITY}
         AND (s.end_line - s.start_line + 1) >= ${MIN_DUPLICATE_LINES}`,
    )
    .all() as Array<{
    shape: string;
    id: number;
    name: string;
    container: string | null;
    complexity: number;
    lines: number;
    path: string;
    fileId: number;
  }>;

  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const bucket = groups.get(row.shape);
    if (bucket) bucket.push(row);
    else groups.set(row.shape, [row]);
  }

  let count = 0;
  for (const [shape, members] of groups) {
    if (members.length < 2) continue;
    // 跨文件才算重复。同文件内形状相同多半是重载或成对的小工具
    const files = new Set(members.map((m) => m.fileId));
    if (files.size < 2) continue;

    const names = [...new Set(members.map((m) => m.name))];
    const key = `dup:${hashShape(shape)}`;
    const related = members.map((m) => `sym:${m.id}`);
    // 同名的重复比不同名的更确定是该合并的；不同名可能只是碰巧同构
    const severity = names.length === 1 ? "high" : "low";
    const label = names.length === 1 ? `${names[0]}()` : `${names[0]}() 等 ${names.length} 个名字`;
    const detail = members
      .map((m) => `${m.path}:${m.container ? `${m.container}.` : ""}${m.name}`)
      .join("\n");

    count++;
    // 每个成员各挂一条，这样在图上点任意一个都能看到它属于哪一组
    for (const member of members) {
      out.push({
        kind: "duplicate",
        severity,
        scopeKind: "symbol",
        scopeKey: `sym:${member.id}`,
        path: member.path,
        title: `${label} 在 ${files.size} 个文件里有结构相同的实现`,
        detail,
        related,
        groupKey: key,
      });
    }
  }

  return count;
}

/** 形状串可以很长，分组键只需要稳定和短 */
function hashShape(shape: string): string {
  let h = 2166136261;
  for (let i = 0; i < shape.length; i++) {
    h ^= shape.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

// ---------------------------------------------------------------------------
// 循环依赖
// ---------------------------------------------------------------------------

/**
 * 互相 import 的同级作用域。
 *
 * 关键在于排除祖先/后代关系。`core/src` 和 `core/src/db` 互相有边是正常的
 * 包含结构（`index.ts` 引用 `db/`，`db/*` 又引用 `../types.ts`），不是循环。
 * 不排除的话，pi 上报出的 43 对里有 38 对是这种假阳性，占 88%——诊断也就
 * 彻底失去意义了。
 *
 * 只做双向直接环。三点以上的长环在真实仓库里往往是「有一条边确实该断」，
 * 但指出哪条边需要的判断远超静态信息，报出来人也不知道该改哪里。
 */
function detectCycles(db: Db, out: FindingRow[]): number {
  let count = 0;
  const packageDirs = new Map(
    (db.prepare("SELECT name, dir FROM packages").all() as Array<{ name: string; dir: string }>).map(
      (r) => [r.name, r.dir],
    ),
  );

  for (const level of ["package", "directory"] as const) {
    const pairs = db
      .prepare(
        `SELECT a.src AS src, a.dst AS dst, a.count AS forward, b.count AS backward
         FROM rollup_edges a
         JOIN rollup_edges b ON a.src = b.dst AND a.dst = b.src AND b.level = a.level
         WHERE a.level = ? AND a.type = 'imports' AND a.src < a.dst`,
      )
      .all(level) as Array<{ src: string; dst: string; forward: number; backward: number }>;

    for (const pair of pairs) {
      if (level === "directory" && isNested(pair.src, pair.dst)) continue;

      const scopeKind = level === "package" ? "package" : "directory";
      const prefix = level === "package" ? "pkg" : "dir";
      const related = [`${prefix}:${pair.src}`, `${prefix}:${pair.dst}`];
      // 包的 scope_key 是包名，但上卷要按目录前缀走，所以路径单独查
      const dirOfScope = (key: string): string =>
        level === "package" ? (packageDirs.get(key) ?? key) : key;
      const detail =
        `${pair.src} → ${pair.dst}：${pair.forward} 处引用\n` +
        `${pair.dst} → ${pair.src}：${pair.backward} 处引用\n` +
        `引用少的那个方向通常就是该断开的那条边。`;

      count++;
      for (const [i, key] of [pair.src, pair.dst].entries()) {
        out.push({
          kind: "cycle",
          severity: level === "package" ? "high" : "medium",
          scopeKind,
          scopeKey: `${prefix}:${key}`,
          path: dirOfScope(key),
          title: `与 ${i === 0 ? pair.dst : pair.src} 相互依赖`,
          detail,
          related,
          groupKey: `cycle:${level}:${pair.src}\u0000${pair.dst}`,
        });
      }
    }
  }

  return count;
}

/** a 是否为 b 的祖先目录，或反之 */
function isNested(a: string, b: string): boolean {
  return b.startsWith(`${a}/`) || a.startsWith(`${b}/`) || a === "." || b === ".";
}
