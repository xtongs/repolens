import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { indexPath } from "./db/database.js";
import type { RegisteredRepo, RepoEntry, RepoStatus } from "./types.js";

export type { RegisteredRepo, RepoEntry, RepoStatus } from "./types.js";

/**
 * 扫过的仓库清单。
 *
 * 索引本身存在各仓库自己的 `.repolens/` 下，这是刻意的——它是可重建的
 * 派生数据，跟着仓库走才能随仓库一起删掉。但这样一来没有任何地方知道
 * 「这台机器上扫过哪些仓库」，界面里就选不了仓库，只能靠重启换路径。
 * 这份清单补的就是这个缺口。
 *
 * 它是便利缓存，不是事实来源：真相永远是各仓库的 index.db 在不在。
 * 所以读取时一律现场探测状态，解析失败就当空清单，绝不因为它坏了
 * 而让整个工具起不来。
 */

export const HOME_DIR = ".repolens";
export const REGISTRY_FILE = "repos.json";

/** 清单保留上限。超出后按最近打开时间淘汰，避免无限增长。 */
const MAX_ENTRIES = 50;

const REGISTRY_VERSION = 1;

export function registryPath(): string {
  return join(homedir(), HOME_DIR, REGISTRY_FILE);
}

/**
 * 仓库标识：绝对路径的短哈希。
 *
 * 不直接用路径当 id，是因为它要进 URL——路径里的斜杠、空格、中文都得转义，
 * 拼错一次就是个查不出来的 404。哈希是定长且 URL 安全的，真实路径照样在
 * 载荷里返回给界面显示，没有信息损失。
 */
export function repoId(root: string): string {
  return createHash("sha1").update(resolve(root)).digest("hex").slice(0, 12);
}

interface RegistryFile {
  version: number;
  repos: RegisteredRepo[];
}

export function readRegistry(): RegisteredRepo[] {
  const file = registryPath();
  if (!existsSync(file)) return [];
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as RegistryFile;
    if (parsed.version !== REGISTRY_VERSION || !Array.isArray(parsed.repos)) return [];
    return parsed.repos.filter(isWellFormed);
  } catch {
    // 手改坏了、写入时断电、或者将来换了格式——一律当没有。
    return [];
  }
}

/** 把仓库记进清单（已存在则刷新打开时间），返回记下的条目。 */
export function rememberRepo(root: string): RegisteredRepo {
  const absolute = resolve(root);
  const entry: RegisteredRepo = {
    id: repoId(absolute),
    root: absolute,
    name: repoDisplayName(absolute),
    lastOpenedAt: new Date().toISOString(),
  };

  const others = readRegistry().filter((r) => r.id !== entry.id);
  writeRegistry([entry, ...others].slice(0, MAX_ENTRIES));
  return entry;
}

/** 从清单移除。返回是否真的移除了什么。 */
export function forgetRepo(id: string): boolean {
  const before = readRegistry();
  const after = before.filter((r) => r.id !== id);
  if (after.length === before.length) return false;
  writeRegistry(after);
  return true;
}

/** 清单 + 现场探测的状态，按最近打开时间降序。 */
export function listRepos(): RepoEntry[] {
  return readRegistry()
    .map((repo) => ({ ...repo, status: probe(repo.root), branch: gitBranch(repo.root) }))
    .sort((a, b) => b.lastOpenedAt.localeCompare(a.lastOpenedAt));
}

/**
 * 不启动 git 子进程，直接读取 HEAD。这样仓库下拉每次打开都能拿到当前分支，
 * 同时不会因为清单里有几十个仓库而串行执行几十次 git。`.git` 为文件的
 * worktree/submodule 也按其中的 gitdir 指针解析。
 */
export function gitBranch(root: string): string | null {
  try {
    const dotGit = findGitMarker(root);
    if (dotGit === null) return null;
    const stat = statSync(dotGit);
    let gitDir = dotGit;
    if (stat.isFile()) {
      const pointer = readFileSync(dotGit, "utf8").trim();
      const match = /^gitdir:\s*(.+)$/i.exec(pointer);
      if (!match?.[1]) return null;
      gitDir = isAbsolute(match[1]) ? match[1] : resolve(dirname(dotGit), match[1]);
    } else if (!stat.isDirectory()) {
      return null;
    }

    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    const ref = /^ref:\s+refs\/heads\/(.+)$/.exec(head);
    if (ref?.[1]) return ref[1];
    return /^[0-9a-f]{7,64}$/i.test(head) ? `detached@${head.slice(0, 7)}` : null;
  } catch {
    return null;
  }
}

/** 扫描目标可以是 monorepo 的子目录，因此向上寻找最近的 Git 根。 */
function findGitMarker(root: string): string | null {
  let directory = resolve(root);
  while (true) {
    const marker = join(directory, ".git");
    if (existsSync(marker)) return marker;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

export function probe(root: string): RepoStatus {
  if (!isDirectory(root)) return "root-missing";
  return existsSync(indexPath(root)) ? "ok" : "index-missing";
}

// ---------------------------------------------------------------------------

/**
 * 仓库显示名取目录名。同名仓库（两个 `web`）靠界面上一并显示的完整路径区分，
 * 这里不做去重。根目录的 basename 为空，退回完整路径。
 */
function repoDisplayName(absolute: string): string {
  return basename(absolute) || absolute;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isWellFormed(r: unknown): r is RegisteredRepo {
  if (typeof r !== "object" || r === null) return false;
  const c = r as Partial<RegisteredRepo>;
  return (
    typeof c.id === "string" &&
    typeof c.root === "string" &&
    typeof c.name === "string" &&
    typeof c.lastOpenedAt === "string"
  );
}

/**
 * 先写临时文件再 rename。
 *
 * rename 在同一文件系统内是原子的，所以读到的永远是某个完整版本。
 * 直接覆盖写的话，两个 repolens 进程同时启动就可能把文件写成半截 JSON，
 * 而这份文件一旦坏掉，每次启动都要先踩一次异常。
 */
function writeRegistry(repos: RegisteredRepo[]): void {
  const file = registryPath();
  mkdirSync(dirname(file), { recursive: true });
  const payload: RegistryFile = { version: REGISTRY_VERSION, repos };
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}
