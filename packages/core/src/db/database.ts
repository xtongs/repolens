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
    const version = readSchemaVersion(db);
    if (version !== SCHEMA_VERSION) {
      db.close();
      throw new Error(
        `索引版本过期（当前 ${version ?? "未知"}，需要 ${SCHEMA_VERSION}）：${dbPath}\n` +
          "运行 `repolens scan` 更新索引",
      );
    }
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
    const steps: Array<(db: Db) => void> = [];
    for (let version = Number(existing); version < Number(SCHEMA_VERSION); version++) {
      const step = MIGRATIONS[String(version)];
      if (!step) break;
      steps.push(step);
    }
    if (steps.length !== Number(SCHEMA_VERSION) - Number(existing)) {
      db.close();
      return openDb(dbPath, { ...opts, fresh: true });
    }
    transact(db, () => {
      for (const step of steps) step(db);
    });
  }

  db.exec(SCHEMA_SQL);
  setMeta(db, "schema_version", SCHEMA_VERSION);
  return db;
}

/**
 * 只加列、删派生表的变更就地迁移，不整库重建：summaries 里的 AI 结果是花钱生成的。
 * 迁移后旧行的新列只有默认值，靠同时调高 EXTRACTOR_VERSION 让下次扫描全部重新解析。
 */
const MIGRATIONS: Record<string, (db: Db) => void> = {
  "5": (db) => {
    addColumns(db, "call_sites", {
      end_byte: "INTEGER NOT NULL DEFAULT 0",
      name_line: "INTEGER NOT NULL DEFAULT 0",
      name_col: "INTEGER NOT NULL DEFAULT 0",
      resolution: "TEXT NOT NULL DEFAULT 'unresolved'",
      target_symbol_id: "INTEGER REFERENCES symbols(id) ON DELETE SET NULL",
      target_name: "TEXT",
      candidates: "TEXT",
      io_kind: "TEXT",
    });
    addColumns(db, "entry_points", {
      reach_symbols: "INTEGER NOT NULL DEFAULT 0",
      reach_files: "INTEGER NOT NULL DEFAULT 0",
      reach_io: "TEXT NOT NULL DEFAULT ''",
    });
    db.exec(`
      DROP TABLE IF EXISTS trace_steps;
      DROP TABLE IF EXISTS traces;
      DROP TABLE IF EXISTS boundaries;
      DELETE FROM summaries WHERE target_kind = 'trace';
    `);
  },
  "6": (db) => {
    addColumns(db, "call_sites", { receiver_type: "TEXT" });
  },
};

function addColumns(db: Db, table: string, columns: Record<string, string>): void {
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((column) => column.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (!present.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

/** `open` 用它判断已有索引能否直接服务；只读探测，不触发迁移或重建。 */
export function isIndexCurrent(dbPath: string): boolean {
  if (!existsSync(dbPath)) return false;
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return readSchemaVersion(db) === SCHEMA_VERSION;
  } catch {
    return false;
  } finally {
    db?.close();
  }
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
