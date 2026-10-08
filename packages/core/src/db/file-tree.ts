import { lstatSync, readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import { join, sep } from "node:path";
import { buildIgnoreMatcher, HARD_IGNORED_DIRS } from "../discovery/ignore.js";
import { detectLanguage } from "../discovery/language.js";
import { createRoleClassifier } from "../discovery/roles.js";
import type { ExclusionReason, FileRole, RepolensConfig, SourceSliceDto, TreeNodeDto } from "../types.js";
import type { Db } from "./database.js";
import { getTree } from "./queries.js";

/** 版本库元数据和 RepoLens 自己的索引不是仓库内容：结构树不列，也不给读 */
const UNLISTED = new Set([".git", ".hg", ".svn", ".repolens", ".DS_Store", "Thumbs.db"]);

const NOISE_ROLES: FileRole[] = ["test", "config", "generated", "types", "docs", "asset"];

/** 侧栏里读得动的上限；再大的文件高亮也会拖慢整个页面 */
const RAW_MAX_BYTES = 2 * 1024 * 1024;

export class RepoFileError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 413 | 415,
  ) {
    super(message);
  }
}

/**
 * 结构树的一层：磁盘上的全部条目，并标出各自在分析里的位置。
 *
 * 索引只收参与分析的文件，结构树要回答的却是「仓库里到底有什么」，所以以磁盘为准逐层列，
 * 再拿索引定性。源码照旧按代码行排热度；进了索引的噪音和没进索引的排在后面，由界面置灰。
 * 没进索引的顺带算出原因。
 */
export function getFileTree(db: Db, repoRoot: string, config: RepolensConfig, path = "."): TreeNodeDto {
  const dir = repoRelative(path);
  const analyzed: TreeNodeDto[] = (getTree(db, dir, 1, ["source"]).children ?? [])
    .map((node) => ({ ...node, status: "analyzed" }));
  const known = new Set(analyzed.map((node) => node.path));
  const noise: TreeNodeDto[] = (getTree(db, dir, 1, NOISE_ROLES).children ?? [])
    .filter((node) => !known.has(node.path))
    .map((node) => ({ ...node, status: "noise", heat: 0 }));
  for (const node of noise) known.add(node.path);

  const rules = exclusionRules(repoRoot, config);
  const inherited = rules.directory(dir);
  const walked = db.prepare("SELECT 1 FROM directories WHERE path = ?");
  const excluded: TreeNodeDto[] = [];
  for (const entry of listDirectory(repoRoot, dir)) {
    const rel = dir === "." ? entry.name : `${dir}/${entry.name}`;
    if (known.has(rel) || UNLISTED.has(entry.name)) continue;
    const isDirectory = entry.isDirectory();
    if (!isDirectory && !entry.isFile() && !entry.isSymbolicLink()) continue;

    // 扫描时走进去了、却没留下任何文件的目录（全是第三方或超大文件，或者空目录）
    if (isDirectory && inherited === null && walked.get(rel)) {
      noise.push(blankNode(`dir:${rel}`, entry.name, rel, "directory", "noise", null));
      continue;
    }
    const reason: ExclusionReason = entry.isSymbolicLink()
      ? "symlink"
      : inherited ?? (isDirectory ? rules.directory(rel) ?? "unscanned" : rules.file(rel));
    const kind = isDirectory ? "directory" : "file";
    excluded.push(blankNode(`raw:${rel}`, entry.name, rel, kind, "excluded", reason));
  }

  const byName = (a: TreeNodeDto, b: TreeNodeDto) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "directory" ? -1 : 1;
  return {
    ...getTree(db, dir, 0),
    children: [...analyzed, ...noise.sort(byName), ...excluded.sort(byName)],
  };
}

/**
 * 读仓库里任意一个文件的原文，给没进索引的文件用。
 * 只认仓库根以内的真实文件：拒绝 `..`、软链接，以及经由软链接目录绕到仓库外的路径。
 */
export function readRepoFile(repoRoot: string, path: string): SourceSliceDto {
  const rel = repoRelative(path);
  if (rel === ".") throw new RepoFileError("不是文件", 400);
  const abs = join(repoRoot, ...rel.split("/"));
  let stat;
  try {
    stat = lstatSync(abs);
  } catch {
    throw new RepoFileError("文件不存在", 404);
  }
  if (stat.isSymbolicLink()) throw new RepoFileError("软链接不跟随，不显示内容", 415);
  if (!stat.isFile()) throw new RepoFileError("不是文件", 400);
  if (!insideRepo(repoRoot, abs)) throw new RepoFileError("文件不存在", 404);
  if (stat.size > RAW_MAX_BYTES) throw new RepoFileError("文件超过 2 MB，不在这里显示", 413);

  const bytes = readFileSync(abs);
  if (bytes.subarray(0, 8000).includes(0)) throw new RepoFileError("二进制文件，不显示内容", 415);
  const code = bytes.toString("utf8");
  return { path: rel, language: detectLanguage(rel), startLine: 1, endLine: code.split("\n").length, code };
}

function exclusionRules(repoRoot: string, config: RepolensConfig) {
  const ignore = buildIgnoreMatcher(repoRoot, config.exclude, config.include);
  const classify = createRoleClassifier(config.roleOverrides);
  return {
    /** 目录自己或任一祖先被排除时，里面的一切跟着排除 */
    directory(rel: string): ExclusionReason | null {
      if (rel === ".") return null;
      const parts = rel.split("/");
      if (parts.some((part) => HARD_IGNORED_DIRS.has(part))) return "builtin";
      for (let depth = 1; depth <= parts.length; depth++) {
        if (ignore.ignores(`${parts.slice(0, depth).join("/")}/`)) return "ignored";
      }
      return null;
    },
    file(rel: string): ExclusionReason {
      if (ignore.ignores(rel)) return "ignored";
      if (classify(rel, detectLanguage(rel)) === "vendor") return "vendor";
      try {
        if (statSync(join(repoRoot, ...rel.split("/"))).size > config.maxFileBytes) return "too-large";
      } catch {
        // 刚被删掉的文件按新出现的处理，下一次列目录就不在了
      }
      return "unscanned";
    },
  };
}

function listDirectory(repoRoot: string, dir: string): Dirent[] {
  const abs = dir === "." ? repoRoot : join(repoRoot, ...dir.split("/"));
  if (!insideRepo(repoRoot, abs)) return [];
  try {
    return readdirSync(abs, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** 请求里的路径一律当仓库相对路径，归一成索引里的写法，仓库根是 "." */
function repoRelative(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.some((part) => part === ".." || /[\\:]/.test(part) || UNLISTED.has(part))) {
    throw new RepoFileError("非法的路径", 400);
  }
  return parts.length === 0 ? "." : parts.join("/");
}

function insideRepo(repoRoot: string, abs: string): boolean {
  try {
    const root = realpathSync(repoRoot);
    const real = realpathSync(abs);
    return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
  } catch {
    return false;
  }
}

function blankNode(
  id: string,
  name: string,
  path: string,
  kind: TreeNodeDto["kind"],
  status: TreeNodeDto["status"],
  excludedBy: ExclusionReason | null,
): TreeNodeDto {
  return {
    id, name, path, kind,
    language: kind === "file" ? detectLanguage(path) : null,
    loc: 0, files: 0, symbols: 0, complexity: 0, heat: 0,
    hasChildren: kind === "directory",
    children: null,
    status, excludedBy,
  };
}
