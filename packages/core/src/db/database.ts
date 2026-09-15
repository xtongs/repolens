import Database from "better-sqlite3";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export type Db = Database.Database;

export const INDEX_DIR = ".repolens";
export const INDEX_FILE = "index.db";

export function indexPath(repoRoot: string): string {
  return join(repoRoot, INDEX_DIR, INDEX_FILE);
}

export interface OpenOptions {
  /** 只读打开，供 server 使用 */
  readonly?: boolean;
  /** 丢弃已有数据重建 */
  fresh?: boolean;
}

export function openDb(dbPath: string, opts: OpenOptions = {}): Db {
  if (opts.readonly) {
    if (!existsSync(dbPath)) {
      throw new Error(`索引不存在：${dbPath}\n先运行 \`repolens scan\``);
    }
    const db = new Database(dbPath, { readonly: true });
    db.pragma("journal_mode = WAL");
    return db;
  }

  mkdirSync(dirname(dbPath), { recursive: true });

  if (opts.fresh) {
    for (const suffix of ["", "-wal", "-shm"]) {
      rmSync(dbPath + suffix, { force: true });
    }
  }

  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  // 批量写入期间把临时结构放内存，扫描 40 万行时省下可观的 I/O。
  db.pragma("temp_store = MEMORY");
  db.pragma("cache_size = -64000");

  const existing = readSchemaVersion(db);
  if (existing !== null && existing !== SCHEMA_VERSION) {
    db.close();
    return openDb(dbPath, { ...opts, fresh: true });
  }

  db.exec(SCHEMA_SQL);
  setMeta(db, "schema_version", SCHEMA_VERSION);
  return db;
}

function readSchemaVersion(db: Db): string | null {
  const hasMeta = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
    .get();
  if (!hasMeta) return null;
  return getMeta(db, "schema_version");
}

export function setMeta(db: Db, key: string, value: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

export function getMeta(db: Db, key: string): string | null {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function getMetaJson<T>(db: Db, key: string, fallback: T): T {
  const raw = getMeta(db, key);
  if (raw === null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function setMetaJson(db: Db, key: string, value: unknown): void {
  setMeta(db, key, JSON.stringify(value));
}

/** 在单个事务里跑一批写入。better-sqlite3 是同步 API，这里不需要处理并发。 */
export function transact<T>(db: Db, fn: () => T): T {
  const run = db.transaction(fn);
  return run();
}
