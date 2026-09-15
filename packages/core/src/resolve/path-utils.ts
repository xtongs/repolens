/**
 * 仓库内部一律使用 posix 相对路径，根目录表示为 `.`。
 *
 * 不用 node:path 是因为它在 Windows 上会产出反斜杠，而路径要作为数据库主键
 * 和前端节点 id 使用，必须跨平台稳定。
 */

export function normalizePosix(path: string): string {
  const isAbsolute = path.startsWith("/");
  const segments: string[] = [];

  for (const part of path.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      const last = segments.at(-1);
      if (last !== undefined && last !== "..") segments.pop();
      else if (!isAbsolute) segments.push("..");
      continue;
    }
    segments.push(part);
  }

  const joined = segments.join("/");
  if (isAbsolute) return `/${joined}`;
  return joined === "" ? "." : joined;
}

export function joinPosix(...parts: string[]): string {
  const meaningful = parts.filter((p) => p !== "" && p !== ".");
  if (meaningful.length === 0) return ".";
  return normalizePosix(meaningful.join("/"));
}

/** 取父目录；根目录的父目录仍是 `.` */
export function dirOf(path: string): string {
  const normalized = normalizePosix(path);
  const slash = normalized.lastIndexOf("/");
  if (slash <= 0) return ".";
  return normalized.slice(0, slash);
}

export function baseName(path: string): string {
  const normalized = normalizePosix(path);
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? normalized : normalized.slice(slash + 1);
}

export function stripExtension(path: string): string {
  const base = baseName(path);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return path;
  return path.slice(0, path.length - (base.length - dot));
}

/** 返回从根到该路径的所有祖先目录，含自身目录，不含 `.` */
export function ancestorDirs(path: string): string[] {
  const dir = dirOf(path);
  if (dir === ".") return [];
  const parts = dir.split("/");
  const out: string[] = [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join("/"));
  return out;
}

export function depthOf(path: string): number {
  if (path === "." || path === "") return 0;
  return path.split("/").length;
}

export function isWithin(dir: string, path: string): boolean {
  if (dir === ".") return true;
  return path === dir || path.startsWith(`${dir}/`);
}
