import { packageEntryFileIds, unapprovedDependencies } from "../db/architecture.js";
import { setMetaJson, transact, type Db } from "../db/database.js";
import { IndexWriter, type FindingRow } from "../db/writer.js";
import type { ArchitectureLock, ConfirmedLayer } from "../types.js";

/**
 * 团队约定改了（界面上确认了分层、批准了当前依赖）之后就地重算相关的体检，
 * 不必为此重扫一遍仓库：只依赖已经链接好的 import，毫秒级。
 */
export function refreshConventions(
  db: Db, policy: { lock?: ArchitectureLock | null; layers?: readonly ConfirmedLayer[] },
): void {
  transact(db, () => {
    const findings: FindingRow[] = [];
    if (policy.lock !== undefined) {
      db.prepare("DELETE FROM findings WHERE kind = 'unapproved'").run();
      detectUnapproved(db, policy.lock, findings);
      setMetaJson(db, "lock", policy.lock ? { level: policy.lock.level, dependencies: policy.lock.dependencies.length } : null);
    }
    if (policy.layers !== undefined) {
      db.prepare("DELETE FROM findings WHERE kind = 'layering'").run();
      detectLayering(db, policy.layers, findings);
      setMetaJson(db, "confirmed_layers", policy.layers);
    }
    new IndexWriter(db).insertFindings(findings);
  });
}

/** 包边界由 package.json 的入口定义的生态；Python、Rust 里直接引子模块是惯用写法 */
const NODE_MANAGERS = new Set(["pnpm", "npm", "yarn"]);
const NODE_LANGUAGES = new Set(["typescript", "tsx", "javascript", "jsx", "vue", "svelte", "astro"]);

/**
 * 依赖锁里没有的模块间依赖。锁是团队批准过的那份依赖清单，新长出来的依赖要么是
 * 合理的演进（批准后 `repolens lock` 更新锁），要么是 AI 顺手越了界——两种都该被人看一眼。
 */
export function detectUnapproved(db: Db, lock: ArchitectureLock | null, out: FindingRow[]): number {
  if (lock === null) return 0;
  const packageDir = new Map(
    (db.prepare("SELECT name, dir FROM packages").all() as Array<{ name: string; dir: string }>).map((row) => [row.name, row.dir]),
  );
  const deps = unapprovedDependencies(db, lock);
  for (const dep of deps) {
    const node = (key: string) => (lock.level === "package" ? `pkg:${key}` : `dir:${key}`);
    const via = dep.type === "http" ? "（HTTP 请求）" : "";
    out.push({
      kind: "unapproved",
      severity: "high",
      scopeKind: lock.level === "package" ? "package" : "directory",
      scopeKey: node(dep.from),
      path: lock.level === "package" ? (packageDir.get(dep.from) ?? dep.from) : dep.from,
      title: `未批准的新依赖：${dep.from} → ${dep.to}${via}`,
      detail: [
        `依赖锁（.repolens.lock.json）里没有这条依赖，共 ${dep.count} 处引用：`,
        ...dep.samples,
        "确认它合理后运行 repolens lock 更新锁文件，让这次批准出现在代码评审里。",
      ].join("\n"),
      related: [node(dep.from), node(dep.to)],
      groupKey: `unapproved:${dep.from}\u0000${dep.to}\u0000${dep.type}`,
    });
  }
  return deps.length;
}

interface LayerMember {
  id: string;
  path: string;
  label: string;
  layer: number;
}

/**
 * 分层倒置：团队确认过的分层自上而下排，下层的源码 import 了上层的源码。
 * 只看人确认过的分层——AI 提议的分层可能分错，拿它判违规等于让模型替人定规矩。
 */
export function detectLayering(db: Db, layers: readonly ConfirmedLayer[], out: FindingRow[]): number {
  if (layers.length < 2) return 0;
  const packageDir = new Map(
    (db.prepare("SELECT name, dir FROM packages").all() as Array<{ name: string; dir: string }>).map((row) => [row.name, row.dir]),
  );
  const members: LayerMember[] = [];
  for (const [layer, entry] of layers.entries()) {
    for (const id of entry.members) {
      const path = id.startsWith("pkg:") ? packageDir.get(id.slice(4)) : id.slice(4);
      if (path === undefined) continue;
      members.push({ id, path, label: id.startsWith("pkg:") ? id.slice(4) : path, layer });
    }
  }
  if (members.length === 0) return 0;
  // 包目录可以嵌套（根包 "." 罩住一切），按最长前缀归属
  members.sort((a, b) => b.path.length - a.path.length);
  const memberOf = (path: string) =>
    members.find((m) => m.path === "." || path === m.path || path.startsWith(`${m.path}/`));

  const rows = db.prepare(
    `SELECT sf.path AS srcPath, tf.path AS dstPath, i.line
     FROM imports i JOIN files sf ON sf.id = i.file_id JOIN files tf ON tf.id = i.target_file_id
     WHERE i.is_type_only = 0 AND sf.role = 'source' AND tf.role = 'source'
     ORDER BY sf.path, i.line`,
  ).all() as Array<{ srcPath: string; dstPath: string; line: number }>;

  const groups = new Map<string, { from: LayerMember; to: LayerMember; samples: string[]; count: number }>();
  for (const row of rows) {
    const from = memberOf(row.srcPath);
    const to = memberOf(row.dstPath);
    if (!from || !to || from.layer <= to.layer) continue;
    const key = `${from.id}\u0000${to.id}`;
    const group = groups.get(key) ?? { from, to, samples: [], count: 0 };
    group.count++;
    if (group.samples.length < 4) group.samples.push(`${row.srcPath}:${row.line} → ${row.dstPath}`);
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const fromLayer = layers[group.from.layer]!.name;
    const toLayer = layers[group.to.layer]!.name;
    out.push({
      kind: "layering",
      severity: "high",
      scopeKind: group.from.id.startsWith("pkg:") ? "package" : "directory",
      scopeKey: group.from.id,
      path: group.from.path,
      title: `分层倒置：「${fromLayer}」的 ${group.from.label} 依赖了上层「${toLayer}」的 ${group.to.label}`,
      detail: [
        `团队确认的分层里「${fromLayer}」在「${toLayer}」之下，下层不该依赖上层。共 ${group.count} 处：`,
        ...group.samples,
      ].join("\n"),
      related: [group.from.id, group.to.id],
      groupKey: `layering:${group.from.id}\u0000${group.to.id}`,
    });
  }
  return groups.size;
}

/**
 * 绕过别的包的入口，直接 import 它的内部文件。包的入口（package.json 的 exports / main、
 * index 文件以及它们再导出的文件）就是它对外承诺的接口；越过入口去拿内部实现，
 * 等于把对方的私事变成了自己的依赖，对方一重构这里就断。AI 找到一个函数就直接按
 * 文件路径引，这是它最常见的越界方式之一。
 *
 * 对方包认不出任何入口时不判：那说明它没声明接口，谈不上绕过。只看 JS/TS 生态的包：
 * Python、Rust 直接引子模块是惯用写法，Go 的 import 本来就是包级的。纯类型 import 不算。
 */
export function detectBypass(db: Db, out: FindingRow[]): number {
  const packages = (db.prepare("SELECT id, name, dir, manager FROM packages").all() as Array<{
    id: number; name: string; dir: string; manager: string;
  }>).filter((p) => NODE_MANAGERS.has(p.manager));
  if (packages.length < 2) return 0;
  const publicFiles = packageEntryFileIds(db);
  const filesByPackage = db.prepare("SELECT id, package_id AS packageId FROM files WHERE role = 'source'").all() as Array<{
    id: number; packageId: number | null;
  }>;
  const declares = new Set(filesByPackage.filter((f) => f.packageId !== null && publicFiles.has(f.id)).map((f) => f.packageId!));
  const byId = new Map(packages.map((p) => [p.id, p]));

  const rows = db.prepare(
    `SELECT i.file_id AS fileId, sf.path AS srcPath, sf.package_id AS srcPackage, i.raw_source AS source, i.line,
            tf.id AS targetId, tf.path AS dstPath, tf.package_id AS dstPackage, tf.language
     FROM imports i JOIN files sf ON sf.id = i.file_id JOIN files tf ON tf.id = i.target_file_id
     WHERE i.is_type_only = 0 AND sf.role = 'source' AND tf.role = 'source'
       AND sf.package_id IS NOT NULL AND tf.package_id IS NOT NULL AND sf.package_id != tf.package_id
     ORDER BY sf.path, i.line`,
  ).all() as Array<{
    fileId: number; srcPath: string; srcPackage: number; source: string; line: number;
    targetId: number; dstPath: string; dstPackage: number; language: string;
  }>;

  const groups = new Map<string, { fileId: number; srcPath: string; pkg: { name: string; dir: string }; relative: boolean; hits: typeof rows }>();
  for (const row of rows) {
    if (!NODE_LANGUAGES.has(row.language) || publicFiles.has(row.targetId) || !declares.has(row.dstPackage)) continue;
    const pkg = byId.get(row.dstPackage);
    if (!pkg) continue;
    // 嵌套包（根包 "."、apps/x 下再套 apps/x/sub）之间的引用是包含关系，不是跨包
    const nested = pkg.dir === "." || row.srcPath.startsWith(`${pkg.dir}/`);
    if (nested) continue;
    const key = `${row.fileId}\u0000${row.dstPackage}`;
    const group = groups.get(key) ?? { fileId: row.fileId, srcPath: row.srcPath, pkg, relative: false, hits: [] };
    group.hits.push(row);
    if (row.source.startsWith(".")) group.relative = true;
    groups.set(key, group);
  }

  for (const group of groups.values()) {
    const targets = [...new Set(group.hits.map((hit) => hit.dstPath))];
    const first = targets[0]!.startsWith(`${group.pkg.dir}/`) ? targets[0]!.slice(group.pkg.dir.length + 1) : targets[0]!;
    out.push({
      kind: "bypass",
      severity: group.relative ? "high" : "medium",
      scopeKind: "file",
      scopeKey: `file:${group.fileId}`,
      path: group.srcPath,
      title: group.relative
        ? `用相对路径跨包引用了 ${group.pkg.name} 的内部文件 ${first}${targets.length > 1 ? ` 等 ${targets.length} 个` : ""}`
        : `绕过 ${group.pkg.name} 的入口，直接引用内部文件 ${first}${targets.length > 1 ? ` 等 ${targets.length} 个` : ""}`,
      detail: [
        `${group.pkg.name} 对外的接口是它的入口文件（package.json 的 exports / main 和 index），这里越过入口拿了内部实现：`,
        ...group.hits.slice(0, 6).map((hit) => `${hit.srcPath}:${hit.line}  ${hit.source}`),
        "改成从包入口引用；入口里没有的，先确认它该不该成为公开接口。",
      ].join("\n"),
      related: [`file:${group.fileId}`, ...new Set(group.hits.map((hit) => `file:${hit.targetId}`))],
      groupKey: `bypass:${group.srcPath}\u0000${group.pkg.name}`,
    });
  }
  return groups.size;
}
