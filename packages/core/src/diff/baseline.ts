import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getMeta, INDEX_DIR, indexPath, isIndexCurrent, openDb } from "../db/database.js";
import { EXTRACTOR_VERSION, EXTRACTOR_VERSION_KEY, scanRepo, type ScanOptions } from "../pipeline/scan.js";

export class BaselineError extends Error {}

export interface Baseline {
  ref: string;
  commit: string;
  dbPath: string;
  /** 命中了之前建好的基线索引 */
  reused: boolean;
}

const KEEP_BASELINES = 6;
/** 同一提交的基线同时被请求两次时共用一次构建，否则两边会往同一个缓存文件里写 */
const building = new Map<string, Promise<Baseline>>();

/**
 * 为某个 git 提交建一份结构索引，作为变更对比的基线。
 *
 * 用 `git archive` 导出快照而不是 checkout / worktree：不碰用户的工作区和 git 元数据，
 * 未提交的改动也不会被卷进来。提交内容不可变，所以索引按 commit 缓存在
 * `.repolens/baselines/`，只有解析器升级时才重建。
 */
export async function buildBaseline(
  root: string, ref: string, onProgress?: ScanOptions["onProgress"],
): Promise<Baseline> {
  // ref 会进 git 的参数表：以 - 开头会被当成选项，其余字符也只放行提交写法里用得到的
  if (ref.startsWith("-") || !/^[\w./~^@{}+-]{1,200}$/.test(ref)) {
    throw new BaselineError(`不支持的提交写法：${ref.slice(0, 80)}`);
  }
  const top = git(root, ["rev-parse", "--show-toplevel"], "不是 git 仓库，没法按提交对比");
  const commit = git(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], `找不到提交 ${ref}`);
  const cacheDir = join(root, INDEX_DIR, "baselines");
  const dbPath = join(cacheDir, `${commit}.db`);
  if (isBaselineCurrent(dbPath)) return { ref, commit, dbPath, reused: true };

  const pending = building.get(dbPath);
  if (pending) return { ...(await pending), ref };
  const task = snapshotAndScan(root, top, commit, cacheDir, dbPath, onProgress)
    .then(() => ({ ref, commit, dbPath, reused: false }))
    .finally(() => building.delete(dbPath));
  building.set(dbPath, task);
  return task;
}

async function snapshotAndScan(
  root: string, top: string, commit: string, cacheDir: string, dbPath: string,
  onProgress: ScanOptions["onProgress"],
): Promise<void> {
  // 扫描根可能是 monorepo 里的子目录，快照里要还原同样的相对位置。让 git 自己算：
  // Windows 的临时目录常是 8.3 短路径（RUNNER~1），和 git 给出的仓库根按字符串比对不上
  const prefix = git(root, ["rev-parse", "--show-prefix"], "没法确定扫描根在仓库里的位置").replace(/\/$/, "");
  const snapshot = mkdtempSync(join(tmpdir(), "repolens-baseline-"));
  try {
    // 子目录在那个提交里还不存在时基线就是空的，git archive 会直接报 pathspec 错
    if (!prefix || succeeds(top, ["cat-file", "-e", `${commit}:${prefix}`])) {
      await extractCommit(top, commit, prefix, snapshot);
    }
    const snapshotRoot = prefix ? join(snapshot, prefix) : snapshot;
    mkdirSync(snapshotRoot, { recursive: true });
    await scanRepo({ root: snapshotRoot, fresh: true, structureOnly: true, onProgress });

    mkdirSync(cacheDir, { recursive: true });
    rmSync(dbPath, { force: true });
    const db = openDb(indexPath(snapshotRoot));
    try {
      await db.backup(dbPath);
    } finally {
      db.close();
    }
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
  pruneBaselines(cacheDir, dbPath);
}

/** 当前 HEAD 的提交号；不在 git 里时为 null */
export function headCommit(root: string): string | null {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], "");
  } catch {
    return null;
  }
}

function isBaselineCurrent(dbPath: string): boolean {
  if (!isIndexCurrent(dbPath)) return false;
  const db = openDb(dbPath, { readonly: true });
  try {
    return getMeta(db, EXTRACTOR_VERSION_KEY) === EXTRACTOR_VERSION;
  } finally {
    db.close();
  }
}

function git(cwd: string, args: string[], failure: string): string {
  try {
    return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    throw new BaselineError(failure);
  }
}

function succeeds(cwd: string, args: string[]): boolean {
  try {
    execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function extractCommit(top: string, commit: string, prefix: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const archive = spawn("git", ["-C", top, "archive", "--format=tar", commit, ...(prefix ? ["--", prefix] : [])], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    // 不用 -C：Git for Windows 自带的 GNU tar 会把 C:\ 里的冒号当成远程主机
    const untar = spawn("tar", ["-x", "-f", "-"], { cwd: into, stdio: ["pipe", "ignore", "pipe"] });
    archive.stdout.pipe(untar.stdin);
    let stderr = "";
    archive.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    untar.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    let pending = 2;
    let settled = false;
    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      reject(new BaselineError(`导出提交 ${commit.slice(0, 8)} 失败：${message}`));
    };
    const done = (code: number | null) => {
      if (code !== 0) return fail(stderr.trim() || `exit ${code}`);
      if (--pending === 0 && !settled) {
        settled = true;
        resolve();
      }
    };
    archive.on("error", (err) => fail(err.message));
    untar.on("error", (err) => fail(err.message));
    archive.on("close", done);
    untar.on("close", done);
  });
}

function pruneBaselines(cacheDir: string, keep: string): void {
  const dbs = readdirSync(cacheDir)
    .filter((name) => name.endsWith(".db"))
    .map((name) => join(cacheDir, name))
    .filter((path) => path !== keep && existsSync(path))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const stale of dbs.slice(KEEP_BASELINES - 1)) {
    for (const suffix of ["", "-wal", "-shm"]) rmSync(`${stale}${suffix}`, { force: true });
  }
}
