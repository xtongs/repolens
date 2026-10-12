import { baseName } from "../resolve/path-utils.js";
import type { FileRole } from "../types.js";
import type { Db } from "./database.js";

/** 一个图节点在仓库里占的那块地方 */
export interface NodeScope {
  id: string;
  kind: "repo" | "package" | "directory" | "file" | "symbol";
  label: string;
  /** 仓库相对路径；仓库根是 "."，符号取所在文件 */
  path: string;
  packageId: number | null;
  /** 范围里的文件 id */
  files: Set<number>;
  /** 符号节点自己的 id */
  symbolId: number | null;
}

const ALL_ROLES: readonly FileRole[] = ["source", "test", "config", "generated", "types", "docs", "asset", "vendor"];

/**
 * 把节点 id 换成它覆盖的文件。包按归属（package_id），目录按路径前缀，文件就是它自己，
 * 符号取所在文件。认不出的 id 返回 null。用 substr 而不是 LIKE 比前缀：目录名里的下划线
 * 会被 LIKE 当成通配符。
 */
export function resolveScope(db: Db, nodeId: string, roles: readonly FileRole[] = ["source"]): NodeScope | null {
  const roleList = roles.length > 0 ? roles : ALL_ROLES;
  const placeholders = roleList.map(() => "?").join(",");
  const ids = (sql: string, ...args: unknown[]) =>
    new Set((db.prepare(`SELECT id FROM files WHERE role IN (${placeholders}) AND ${sql}`).all(...roleList, ...args) as Array<{ id: number }>)
      .map((row) => row.id));

  if (nodeId === "dir:." || nodeId === "repo") {
    return { id: "dir:.", kind: "repo", label: "repo", path: ".", packageId: null, files: ids("1 = 1"), symbolId: null };
  }
  if (nodeId.startsWith("pkg:")) {
    const pkg = db.prepare("SELECT id, name, dir FROM packages WHERE name = ?").get(nodeId.slice(4)) as
      | { id: number; name: string; dir: string } | undefined;
    if (!pkg) return null;
    return { id: nodeId, kind: "package", label: pkg.name, path: pkg.dir, packageId: pkg.id, files: ids("package_id = ?", pkg.id), symbolId: null };
  }
  if (nodeId.startsWith("dir:")) {
    const path = nodeId.slice(4);
    return {
      id: nodeId, kind: "directory", label: baseName(path), path, packageId: null,
      files: ids("substr(path, 1, length(?) + 1) = ? || '/'", path, path), symbolId: null,
    };
  }
  if (nodeId.startsWith("file:")) {
    const file = db.prepare("SELECT id, path, package_id AS packageId FROM files WHERE id = ?").get(Number(nodeId.slice(5))) as
      | { id: number; path: string; packageId: number | null } | undefined;
    if (!file) return null;
    return { id: nodeId, kind: "file", label: baseName(file.path), path: file.path, packageId: file.packageId, files: new Set([file.id]), symbolId: null };
  }
  if (nodeId.startsWith("sym:")) {
    const symbol = db.prepare(
      `SELECT s.id, s.name, s.container, f.id AS fileId, f.path, f.package_id AS packageId
       FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?`,
    ).get(Number(nodeId.slice(4))) as
      | { id: number; name: string; container: string | null; fileId: number; path: string; packageId: number | null } | undefined;
    if (!symbol) return null;
    return {
      id: nodeId, kind: "symbol", label: symbol.container ? `${symbol.container}.${symbol.name}` : symbol.name,
      path: symbol.path, packageId: symbol.packageId, files: new Set([symbol.fileId]), symbolId: symbol.id,
    };
  }
  return null;
}

/** 范围里参与统计的函数：源码里有实现的函数和方法；符号节点就是它自己 */
export function scopeFunctions(db: Db, scope: NodeScope): Array<{ id: number; fileId: number; hash: string; complexity: number }> {
  if (scope.symbolId !== null) {
    return db.prepare("SELECT id, file_id AS fileId, hash, complexity FROM symbols WHERE id = ?").all(scope.symbolId) as Array<{
      id: number; fileId: number; hash: string; complexity: number;
    }>;
  }
  return inBatches([...scope.files], (batch) => db.prepare(
    `SELECT s.id, s.file_id AS fileId, s.hash, s.complexity FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.role = 'source' AND s.kind IN ('function', 'method') AND s.implemented = 1
       AND s.file_id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number; fileId: number; hash: string; complexity: number }>);
}

/** SQLite 的参数个数有上限，大范围分批查 */
export function inBatches<T, R>(items: readonly T[], run: (batch: T[]) => R[], size = 400): R[] {
  const out: R[] = [];
  for (let offset = 0; offset < items.length; offset += size) out.push(...run(items.slice(offset, offset + size)));
  return out;
}
