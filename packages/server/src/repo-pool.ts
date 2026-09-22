import {
  indexPath,
  gitBranch,
  listRepos,
  openDb,
  probe,
  repoId,
  type Db,
  type RepoEntry,
} from "@repolens/core";
import type { Hono } from "hono";
import { basename, resolve } from "node:path";
import { createApi } from "./api.js";

export class RepoUnavailableError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message);
  }
}

interface PooledRepo {
  id: string;
  root: string;
  db: Db;
  /** 该仓库的 API 子应用 */
  api: Hono;
  usedAt: number;
}

/**
 * 按仓库持有只读连接的池子。
 *
 * 界面要能换仓库，而 `createApi` 是闭包在一个 db 上的。两种改法：把 db
 * 变成每个路由现取（要动全部十个端点），或者每个仓库一份 API 子应用、
 * 在外层按请求分发（api.ts 一行不用改）。选后者。
 *
 * **可达范围就是安全边界**：只能打开清单里已有的仓库，或者启动时指定的
 * 那个。API 不接受网页提交的任意路径——`/source` 会按仓库根读源码，如果
 * 允许现场指定路径，任何能连上这个端口的东西就都能读机器上的任意文件了。
 * 新仓库只能由命令行，或服务端直接唤起的本机系统目录选择器加入清单。
 */
export class RepoPool {
  private readonly open = new Map<string, PooledRepo>();
  private readonly defaultId: string;
  private readonly defaultRoot: string;

  /**
   * @param maxOpen 同时保持打开的连接数上限。每个连接都占文件描述符和
   *   WAL 映射，一路点过二十个仓库不该攒下二十个句柄；超出后按最久未用
   *   关闭。启动时指定的那个仓库固定驻留，不参与淘汰。
   */
  constructor(
    defaultRoot: string,
    private readonly maxOpen = 4,
  ) {
    this.defaultRoot = resolve(defaultRoot);
    this.defaultId = repoId(this.defaultRoot);
  }

  get currentId(): string {
    return this.defaultId;
  }

  /**
   * 清单 + 启动时那个仓库。
   *
   * 启动的仓库要单独兜一次：清单写入可能因为 home 目录不可写而失败，
   * 那种情况下界面至少还得能看见自己正在看的这个。
   */
  list(): RepoEntry[] {
    const entries = listRepos();
    if (!entries.some((e) => e.id === this.defaultId)) {
      entries.unshift({
        id: this.defaultId,
        root: this.defaultRoot,
        name: basename(this.defaultRoot) || this.defaultRoot,
        lastOpenedAt: new Date().toISOString(),
        status: probe(this.defaultRoot),
        branch: gitBranch(this.defaultRoot),
      });
    }
    return entries;
  }

  /** 只允许把启动仓库或清单里的仓库 id 还原成路径，供安全的重扫入口使用。 */
  root(id: string): string {
    return this.rootOf(id);
  }

  /** 解析仓库标识；缺省时给启动时那个。打不开就抛 RepoUnavailableError。 */
  resolve(id: string | undefined): PooledRepo {
    const target = id === undefined || id === "" ? this.defaultId : id;

    const cached = this.open.get(target);
    if (cached) {
      cached.usedAt = Date.now();
      return cached;
    }

    const root = this.rootOf(target);
    const status = probe(root);
    if (status === "root-missing") {
      throw new RepoUnavailableError(`仓库目录不存在：${root}`, 404);
    }
    if (status === "index-missing") {
      throw new RepoUnavailableError(`该仓库尚未建立索引，先运行 \`repolens scan ${root}\``, 404);
    }

    const db = openDb(indexPath(root), { readonly: true });
    const entry: PooledRepo = {
      id: target,
      root,
      db,
      api: createApi({ db, repoRoot: root }),
      usedAt: Date.now(),
    };
    this.open.set(target, entry);
    this.evictIfNeeded();
    return entry;
  }

  close(): void {
    for (const entry of this.open.values()) entry.db.close();
    this.open.clear();
  }

  private rootOf(id: string): string {
    if (id === this.defaultId) return this.defaultRoot;
    const found = listRepos().find((r) => r.id === id);
    if (!found) throw new RepoUnavailableError(`未知的仓库标识：${id}`, 400);
    return found.root;
  }

  private evictIfNeeded(): void {
    while (this.open.size > this.maxOpen) {
      let oldest: PooledRepo | null = null;
      for (const entry of this.open.values()) {
        if (entry.id === this.defaultId) continue;
        if (oldest === null || entry.usedAt < oldest.usedAt) oldest = entry;
      }
      if (oldest === null) return;
      oldest.db.close();
      this.open.delete(oldest.id);
    }
  }
}
