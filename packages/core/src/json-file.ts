import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** 先写临时文件再改名，写到一半崩溃也不会留下半截 JSON */
export function writeJsonAtomically(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}

/**
 * 按 `{ version: 1, <key>: [...] }` 存在 `.repolens/` 下的一份本地列表（比如笔记）。
 * 文件损坏时直接报错，不能当成空列表再写回去，那会把用户记下的东西覆盖掉；
 * 单条认不出的丢掉，不让一条坏数据拖垮整份列表。
 */
export class JsonListFile<T> {
  constructor(
    private readonly path: string,
    private readonly key: string,
    /** 报错时怎么称呼这份文件，如「笔记文件」 */
    private readonly label: string,
    private readonly accept: (item: unknown) => item is T,
  ) {}

  read(): T[] {
    if (!existsSync(this.path)) return [];
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.path, "utf8"));
    } catch (err) {
      throw new Error(`${this.label}无法解析：${this.path}（${(err as Error).message}）`);
    }
    const list = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>)[this.key] : undefined;
    if (!Array.isArray(list)) throw new Error(`${this.label}格式不对：${this.path}`);
    return list.filter(this.accept);
  }

  write(items: readonly T[]): void {
    writeJsonAtomically(this.path, { version: 1, [this.key]: items });
  }

  /** 删掉命中的条目；一条都没命中时返回 false，也不写文件 */
  remove(matches: (item: T) => boolean): boolean {
    const items = this.read();
    const remaining = items.filter((item) => !matches(item));
    if (remaining.length === items.length) return false;
    this.write(remaining);
    return true;
  }
}
