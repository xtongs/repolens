import type { ArchitectureLock, LockedDependency } from "../types.js";
import type { Db } from "./database.js";

/** 被当成「模块」的那一层：架构图首屏上的那些节点 */
export interface ArchitectureModule {
  id: string;
  label: string;
  path: string;
  packageId?: number;
}

export interface ModuleDependency extends LockedDependency {
  /** 构成这条依赖的 import 次数 */
  count: number;
  /** 前几处 import：`文件:行` */
  samples: string[];
}

/**
 * 架构的模块层：多包仓库按包；单包按目录。单包仓库常见的形状是根目录下只有一个
 * src/，按第一层目录分只会得到一个模块，所以沿着「只有一个子目录装着全部源码」的链
 * 往下走，直到出现分叉。AI 分层、依赖锁和模块间依赖检查用的都是这同一层。
 */
export function architectureModules(db: Db): ArchitectureModule[] {
  const packages = db.prepare(
    `SELECT p.id, p.name, p.dir, COUNT(f.id) AS files FROM packages p
     LEFT JOIN files f ON f.package_id = p.id AND f.role = 'source'
     GROUP BY p.id HAVING files > 0 ORDER BY files DESC`,
  ).all() as Array<{ id: number; name: string; dir: string; files: number }>;
  if (packages.length >= 2) {
    return packages.map((p) => ({ id: `pkg:${p.name}`, label: p.name, path: p.dir, packageId: p.id }));
  }

  const children = db.prepare("SELECT path, name FROM directories WHERE parent_path = ? ORDER BY loc DESC");
  const sourceUnder = db.prepare(
    "SELECT COUNT(*) AS n FROM files WHERE role = 'source' AND (dir_path = ? OR path LIKE ? || '/%')",
  );
  const sourceDirectlyIn = db.prepare("SELECT COUNT(*) AS n FROM files WHERE role = 'source' AND dir_path = ?");
  let current = ".";
  for (let depth = 0; depth < 8; depth++) {
    const kids = (children.all(current) as Array<{ path: string; name: string }>)
      .filter((dir) => (sourceUnder.get(dir.path, dir.path) as { n: number }).n > 0);
    if (kids.length === 1 && (sourceDirectlyIn.get(current) as { n: number }).n === 0) {
      current = kids[0]!.path;
      continue;
    }
    return kids.slice(0, 100).map((dir) => ({ id: `dir:${dir.path}`, label: dir.name, path: dir.path }));
  }
  return [];
}

/**
 * 模块之间的运行时依赖（import 与前端到后端的 HTTP 请求），只算源码到源码。
 * 纯类型引用不算：共享 DTO 类型不构成运行时耦合，锁住它只会制造噪音。
 */
export function moduleDependencies(db: Db, modules: readonly ArchitectureModule[] = architectureModules(db)): ModuleDependency[] {
  const keyOf = (module: ArchitectureModule) => (module.id.startsWith("pkg:") ? module.label : module.path);
  const byPackage = new Map(modules.flatMap((m) => (m.packageId === undefined ? [] : [[m.packageId, m] as const])));
  const byPath = modules.filter((m) => m.packageId === undefined).sort((a, b) => b.path.length - a.path.length);
  const owner = (path: string, packageId: number | null): ArchitectureModule | undefined =>
    byPackage.size > 0
      ? (packageId === null ? undefined : byPackage.get(packageId))
      : byPath.find((m) => path === m.path || path.startsWith(`${m.path}/`));

  const rows = db.prepare(
    `SELECT e.type, e.weight, sf.path AS srcPath, sf.package_id AS srcPackage, tf.path AS dstPath, tf.package_id AS dstPackage
     FROM edges e
     JOIN files sf ON sf.id = e.src_id
     JOIN files tf ON tf.id = e.dst_id
     WHERE e.src_kind = 'file' AND e.dst_kind = 'file' AND e.type IN ('imports', 'http')
       AND sf.role = 'source' AND tf.role = 'source'`,
  ).all() as Array<{ type: "imports" | "http"; weight: number; srcPath: string; srcPackage: number | null; dstPath: string; dstPackage: number | null }>;
  const sample = db.prepare(
    `SELECT sf.path, i.line FROM imports i JOIN files sf ON sf.id = i.file_id JOIN files tf ON tf.id = i.target_file_id
     WHERE sf.path = ? AND tf.path = ? AND i.is_type_only = 0 ORDER BY i.line LIMIT 1`,
  );

  const out = new Map<string, ModuleDependency>();
  for (const row of rows) {
    const from = owner(row.srcPath, row.srcPackage);
    const to = owner(row.dstPath, row.dstPackage);
    if (!from || !to || from.id === to.id) continue;
    const key = `${from.id}\u0000${to.id}\u0000${row.type}`;
    let dep = out.get(key);
    if (!dep) {
      dep = { from: keyOf(from), to: keyOf(to), type: row.type, count: 0, samples: [] };
      out.set(key, dep);
    }
    dep.count += row.weight;
    if (dep.samples.length < 3) {
      const hit = row.type === "imports" ? (sample.get(row.srcPath, row.dstPath) as { path: string; line: number } | undefined) : undefined;
      dep.samples.push(hit ? `${hit.path}:${hit.line}` : `${row.srcPath} → ${row.dstPath}`);
    }
  }
  return [...out.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to) || a.type.localeCompare(b.type));
}

/** 把当前的模块间依赖记成一份锁：以后新出现的依赖都要经过一次显式批准 */
export function buildLock(db: Db): ArchitectureLock {
  const modules = architectureModules(db);
  const level = modules.some((m) => m.id.startsWith("pkg:")) ? "package" : "directory";
  return {
    version: 1,
    level,
    modules: level === "directory" ? modules.map((m) => m.path) : [],
    dependencies: moduleDependencies(db, modules).map(({ from, to, type }) => ({ from, to, type })),
  };
}

/**
 * 找真正面向包外的源码入口。`export function` 只说明它可从当前模块导出，
 * 不能说明这个模块就是包的公共表面；把所有模块导出都当入口会让工具函数
 * 淹没入口列表。Node 包按 package.json 入口映射到源码，其他语言按自身的
 * 包入口约定处理。Go 的导出是包级语义，因此保留包内所有导出函数。
 */
export function publicApiFileIds(db: Db): Set<number> {
  const out = packageEntryFileIds(db);

  // barrel 文件通常没有自己的函数，只用 `export * from "./foo"` 暴露实现。
  // 沿解析成功的 re-export 递归扩展，否则真实公共函数仍会全部漏掉。
  const reexports = db.prepare(
    `SELECT file_id AS sourceId, target_file_id AS targetId FROM imports
     WHERE kind = 're-export' AND target_file_id IS NOT NULL`,
  ).all() as Array<{ sourceId: number; targetId: number }>;
  let changed = true;
  while (changed) {
    changed = false;
    for (const edge of reexports) {
      if (!out.has(edge.sourceId) || out.has(edge.targetId)) continue;
      out.add(edge.targetId);
      changed = true;
    }
  }
  return out;
}

/**
 * 包自己声明的入口文件：package.json 的 exports / main / module / types 映射回源码，
 * 加上约定的 index。不含 re-export 链——别的包该从这些路径引它，越过它们去引被
 * 再导出的内部文件，照样是绕过了接口。
 */
export function packageEntryFileIds(db: Db): Set<number> {
  const packages = db.prepare(
    "SELECT id, dir, entry_points AS entryPoints FROM packages",
  ).all() as Array<{ id: number; dir: string; entryPoints: string }>;
  const files = db.prepare(
    "SELECT id, path, language, package_id AS packageId FROM files",
  ).all() as Array<{ id: number; path: string; language: string; packageId: number | null }>;
  const entryMatchers = new Map<number, RegExp[]>();
  for (const pkg of packages) {
    const entries = parseStrings(pkg.entryPoints)
      .filter((entry) => entry !== "package.json")
      .flatMap(sourceEntryCandidates);
    entryMatchers.set(pkg.id, [...new Set(entries)].map(pathPattern));
  }

  const out = new Set<number>();
  for (const file of files) {
    if (file.language === "go") {
      out.add(file.id);
      continue;
    }
    const relative = packageRelativePath(file.path, file.packageId, packages);
    const conventional = /^(?:src\/)?(?:index\.(?:[cm]?[jt]sx?|py)|__init__\.py|lib\.rs|mod\.rs)$/.test(relative);
    const configured = file.packageId !== null &&
      (entryMatchers.get(file.packageId) ?? []).some((matcher) => matcher.test(relative));
    if (conventional || configured) out.add(file.id);
  }
  return out;
}

function packageRelativePath(
  filePath: string,
  packageId: number | null,
  packages: readonly { id: number; dir: string }[],
): string {
  const dir = packages.find((pkg) => pkg.id === packageId)?.dir;
  if (!dir || dir === ".") return filePath;
  return filePath.startsWith(`${dir}/`) ? filePath.slice(dir.length + 1) : filePath;
}

/** dist/foo.js、dist/foo.d.ts 等发布入口都映射回 src/foo 的源码族。 */
function sourceEntryCandidates(entry: string): string[] {
  const clean = entry.startsWith("./") ? entry.slice(2) : entry;
  const source = clean.startsWith("dist/") || clean.startsWith("build/")
    ? `src/${clean.slice(clean.indexOf("/") + 1)}`
    : clean;
  const stem = source.replace(/(?:\.d)?\.(?:[cm]?js|tsx?|jsx|py|rs|go)$/, "");
  return [
    source,
    `${stem}.ts`, `${stem}.tsx`, `${stem}.js`, `${stem}.jsx`,
    `${stem}.py`, `${stem}.rs`, `${stem}.go`,
  ];
}

function pathPattern(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`);
}

function parseStrings(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/**
 * 锁里没有的模块间依赖。锁记的是目录模块时按锁里的目录划分，而不是按现在算出来的：
 * 目录结构改了，锁就该重新生成，不能悄悄换一套划分把新依赖藏过去。
 */
export function unapprovedDependencies(db: Db, lock: ArchitectureLock): ModuleDependency[] {
  const modules: ArchitectureModule[] = lock.level === "package"
    ? architectureModules(db).filter((m) => m.id.startsWith("pkg:"))
    : lock.modules.map((path) => ({ id: `dir:${path}`, label: path.split("/").at(-1) ?? path, path }));
  if (lock.level === "package" && modules.length < 2) return [];
  const approved = new Set(lock.dependencies.map((d) => `${d.from}\u0000${d.to}\u0000${d.type}`));
  return moduleDependencies(db, modules).filter((dep) => !approved.has(`${dep.from}\u0000${dep.to}\u0000${dep.type}`));
}
