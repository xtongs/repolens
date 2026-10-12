import {
  indexPath,
  isIndexCurrent,
  gitBranch,
  rememberRepo,
  scanRepo,
  type RegisteredRepo,
  type RepoEntry,
  type RepoScanTaskDto,
  type ScanPhase,
} from "@repolens/core";
import { randomUUID } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, parse, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

type ScanWorkerMessage =
  | { type: "progress"; phase: ScanPhase; done: number; total: number }
  | { type: "completed" }
  | { type: "failed"; error: string };

const PHASES: ReadonlyArray<{ phase: ScanPhase; weight: number }> = [
  { phase: "discover", weight: 0.05 },
  { phase: "parse", weight: 0.55 },
  { phase: "resolve", weight: 0 },
  { phase: "link", weight: 0.08 },
  { phase: "rollup", weight: 0.05 },
  { phase: "enrich", weight: 0.22 },
  { phase: "index", weight: 0.05 },
];

const MAX_RETAINED_TASKS = 20;

export class ScanBusyError extends Error {}
export class InvalidScanRootError extends Error {}

/** 内存扫描任务队列。服务重启后任务消失，但已写好的索引不会消失。 */
export class ScanManager {
  private readonly tasks = new Map<string, RepoScanTaskDto>();
  private activeId: string | null = null;
  private activeWorker: Worker | null = null;
  /** 正在跑的结构刷新，按仓库根；同一个仓库同时只跑一次 */
  private readonly refreshing = new Map<string, Promise<void>>();
  /** 刷新期间又来了请求：当前这次跑完再补一次，保证最后一次改动一定被收进去 */
  private readonly dirty = new Set<string>();
  private readonly refreshWorkers = new Set<Worker>();

  /** 这个仓库正在做一次完整扫描（添加或重扫） */
  isScanning(root: string): boolean {
    const active = this.activeId === null ? undefined : this.tasks.get(this.activeId);
    return active?.status === "running" && active.root === resolve(root);
  }

  /**
   * 只刷新结构的增量扫描，不调用模型、不占用扫描任务槽位，也不在仓库菜单里显示进度：
   * 文件改动后的自动刷新、「重新扫描并对比」都走这里。同一仓库并发的请求合并成一次，
   * 期间又有新请求就在这次跑完后再补一次。完整扫描正在写同一个索引时等它结束——它会把这些改动一并收进去。
   */
  refresh(root: string): Promise<void> {
    const key = resolve(root);
    const running = this.refreshing.get(key);
    if (running) {
      this.dirty.add(key);
      return running;
    }
    const task = (async () => {
      do {
        this.dirty.delete(key);
        while (this.isScanning(key)) await delay(300);
        await this.runRefresh(key);
      } while (this.dirty.has(key));
    })().finally(() => this.refreshing.delete(key));
    this.refreshing.set(key, task);
    return task;
  }

  private runRefresh(root: string): Promise<void> {
    // 直接跑 TS 源码时（测试、开发）还没有编译出来的 worker 脚本，就地扫描
    const script = new URL("./scan-worker.js", import.meta.url);
    if (script.protocol === "file:" && !existsSync(fileURLToPath(script))) {
      return scanRepo({ root, structureOnly: true }).then(() => undefined);
    }
    return new Promise((done, fail) => {
      let worker: Worker;
      try {
        worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
          workerData: { root, structureOnly: true },
          execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
        });
      } catch (err) {
        fail(err);
        return;
      }
      this.refreshWorkers.add(worker);
      let settled = false;
      const finish = (err: Error | null) => {
        if (settled) return;
        settled = true;
        this.refreshWorkers.delete(worker);
        if (err) fail(err); else done();
      };
      worker.on("message", (message: ScanWorkerMessage) => {
        if (message.type === "completed") finish(null);
        else if (message.type === "failed") finish(new Error(message.error));
      });
      worker.on("error", (err) => finish(err));
      worker.on("exit", (code) => finish(code === 0 ? null : new Error(`刷新进程退出（代码 ${code}）`)));
    });
  }

  start(selectedRoot: string, options: { scanExisting?: boolean } = {}): RepoScanTaskDto {
    if (this.activeId !== null) {
      const active = this.tasks.get(this.activeId);
      if (active?.status === "running") {
        throw new ScanBusyError(`正在扫描 ${active.name}，请等待当前任务完成`);
      }
      this.activeId = null;
    }

    const root = validateRoot(selectedRoot);
    const now = new Date().toISOString();
    const task: RepoScanTaskDto = {
      id: randomUUID(),
      root,
      name: basename(root) || root,
      status: "running",
      phase: null,
      done: 0,
      total: 0,
      progress: 0,
      startedAt: now,
      completedAt: null,
      error: null,
      repo: null,
    };
    this.tasks.set(task.id, task);
    this.trim();

    // 已有可用索引时只需把仓库登记进清单，不做一次没有意义的重扫。
    if (!options.scanExisting && isIndexCurrent(indexPath(root))) {
      try {
        task.repo = asEntry(rememberRepo(root));
        task.status = "completed";
        task.progress = 1;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        fail(task, err);
      }
      return snapshot(task);
    }

    this.activeId = task.id;
    this.run(task);
    return snapshot(task);
  }

  get(id: string): RepoScanTaskDto | null {
    const task = this.tasks.get(id);
    return task ? snapshot(task) : null;
  }

  list(): RepoScanTaskDto[] {
    return [...this.tasks.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map(snapshot);
  }

  async close(): Promise<void> {
    const worker = this.activeWorker;
    const task = this.activeId === null ? null : this.tasks.get(this.activeId);
    this.activeWorker = null;
    this.activeId = null;
    if (task?.status === "running") fail(task, new Error("服务已停止，扫描中断"));
    if (worker !== null) await worker.terminate();
    await Promise.all([...this.refreshWorkers].map((w) => w.terminate()));
    this.refreshWorkers.clear();
  }

  private run(task: RepoScanTaskDto): void {
    // 解析与 SQLite 写入含有大量同步 CPU 工作。放在 worker 中才能让主线程
    // 持续响应进度轮询，而不是直到扫描结束才一次性刷新到 100%。
    let worker: Worker;
    try {
      worker = new Worker(new URL("./scan-worker.js", import.meta.url), {
        workerData: { root: task.root },
        // 某些嵌入式启动方式会给主进程附加只适用于 stdin/eval 的参数，
        // 原样继承会让 worker 在执行脚本前就退出。
        execArgv: process.execArgv.filter((arg) => !arg.startsWith("--input-type")),
      });
    } catch (err) {
      fail(task, err);
      if (this.activeId === task.id) this.activeId = null;
      return;
    }
    this.activeWorker = worker;
    const release = () => {
      if (this.activeId === task.id) this.activeId = null;
      if (this.activeWorker === worker) this.activeWorker = null;
    };

    worker.on("message", (message: ScanWorkerMessage) => {
      if (task.status !== "running") return;
      if (message.type === "progress") {
        task.phase = message.phase;
        task.done = message.done;
        task.total = message.total;
        task.progress = phaseProgress(message.phase, message.done, message.total);
        return;
      }
      if (message.type === "failed") {
        fail(task, new Error(message.error));
        release();
        return;
      }

      try {
        task.repo = asEntry(rememberRepo(task.root));
        task.status = "completed";
        task.progress = 1;
        task.completedAt = new Date().toISOString();
      } catch (err) {
        fail(task, err);
      } finally {
        release();
      }
    });

    worker.on("error", (err) => {
      if (task.status !== "running") return;
      fail(task, err);
      release();
    });

    worker.on("exit", (code) => {
      if (task.status !== "running") return;
      fail(task, new Error(`扫描进程在返回结果前退出（代码 ${code}）`));
      release();
    });
  }

  private trim(): void {
    if (this.tasks.size <= MAX_RETAINED_TASKS) return;
    const completed = [...this.tasks.values()]
      .filter((task) => task.status !== "running")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (this.tasks.size > MAX_RETAINED_TASKS) {
      const oldest = completed.shift();
      if (!oldest) return;
      this.tasks.delete(oldest.id);
    }
  }
}

function validateRoot(input: string): string {
  const root = resolve(input);
  try {
    if (!statSync(root).isDirectory()) throw new Error("不是目录");
  } catch {
    throw new InvalidScanRootError(`所选目录不存在或无法访问：${root}`);
  }

  // 扫描文件系统根目录或整个家目录几乎一定是误操作，而且可能耗时数小时。
  if (root === parse(root).root || root === resolve(homedir())) {
    throw new InvalidScanRootError("请选择具体的代码仓库目录，不要选择磁盘根目录或整个用户目录");
  }
  return root;
}

function phaseProgress(phase: ScanPhase, done: number, total: number): number {
  let before = 0;
  let weight = 0;
  for (const item of PHASES) {
    if (item.phase === phase) {
      weight = item.weight;
      break;
    }
    before += item.weight;
  }
  const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
  return Math.min(0.99, before + weight * fraction);
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function asEntry(repo: RegisteredRepo): RepoEntry {
  return { ...repo, status: "ok", branch: gitBranch(repo.root) };
}

function fail(task: RepoScanTaskDto, err: unknown): void {
  task.status = "failed";
  task.error = err instanceof Error ? err.message : String(err);
  task.completedAt = new Date().toISOString();
}

function snapshot(task: RepoScanTaskDto): RepoScanTaskDto {
  return { ...task, repo: task.repo ? { ...task.repo } : null };
}
