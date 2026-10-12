import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCheck } from "../check.js";
import { writeLock } from "../config.js";
import { getLens } from "../lens.js";
import { scanRepo } from "../pipeline/scan.js";
import { GENERATED_TOUR_ID, listTours, resolveRef, saveTour, stableRef } from "../tours.js";
import { getUnderstanding, markUnderstood, understandingLens } from "../understanding.js";
import { buildLock } from "./architecture.js";
import { getBoundary, getModuleCard } from "./boundary.js";
import { indexPath, openDb, type Db } from "./database.js";
import { getFileDetail, getSymbolDetail } from "./queries.js";
import { getSkeleton, getTypeFlow } from "./skeleton.js";
import { getSpec } from "./spec.js";
import { getWalkFrame } from "./walk.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-insight-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(root: string, files: Record<string, string>): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
}

/** 三个包：app → service → store，store 用 SQL 读写 items 表 */
async function fixture(): Promise<{ root: string; db: Db; id: (name: string) => number }> {
  const root = mkdtempSync(join(tmpdir(), "repolens-insight-"));
  roots.push(root);
  write(root, {
    ".repolens.json": JSON.stringify({ llm: { enabled: false } }),
    "package.json": JSON.stringify({ name: "mono", private: true }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
    "packages/store/package.json": JSON.stringify({ name: "@x/store", main: "src/index.ts" }),
    "packages/store/src/index.ts": `
      export interface Item { id: string; title: string }
      declare const db: { prepare(sql: string): { all(...a: unknown[]): unknown[]; run(...a: unknown[]): void } };
      export function loadItems(): Item[] { return db.prepare("SELECT id, title FROM items WHERE done = 0").all() as Item[]; }
      export function saveItem(item: Item): void { db.prepare("INSERT INTO items (id, title) VALUES (?, ?)").run(item.id, item.title); }
      export function makeItem(title: string): Item { return { id: title, title }; }
    `,
    "packages/service/package.json": JSON.stringify({ name: "@x/service", main: "src/index.ts" }),
    "packages/service/src/index.ts": `
      import { loadItems, saveItem, makeItem, type Item } from "@x/store";
      export function log(message: string): void { void message; }
      export function listOpen(): Item[] {
        log("list"); log("a"); log("b"); log("c"); log("d"); log("e"); log("f"); log("g");
        return loadItems();
      }
      export function add(title: string): Item {
        if (title === "") throw new Error("empty");
        const item = makeItem(title);
        saveItem(item);
        log("added");
        return item;
      }
      export function addAll(titles: string[]): void { for (const t of titles) add(t); }
      export function forward(title: string) { return add(title); }
    `,
    "packages/service/src/index.test.ts": `
      import { describe, expect, it } from "vitest";
      import { add, listOpen } from "./index";
      describe("service", () => {
        it("adds an item", () => { expect(add("x").title).toBe("x"); });
        it("lists open items", () => { expect(listOpen()).toEqual([]); });
      });
    `,
    "packages/app/package.json": JSON.stringify({ name: "@x/app", main: "src/main.ts" }),
    "packages/app/src/main.ts": `
      import { addAll, listOpen } from "@x/service";
      export function main(args: string[]) { addAll(args); return listOpen(); }
    `,
  });
  execFileSync("git", ["-C", root, "init", "-q"]);
  execFileSync("git", ["-C", root, "config", "core.autocrlf", "false"]);
  execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"]);
  execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-qm", "init"]);
  await scanRepo({ root, fresh: true });
  const db = openDb(indexPath(root), { readonly: true });
  const id = (name: string) => (db.prepare("SELECT id FROM symbols WHERE name = ? ORDER BY id LIMIT 1").get(name) as { id: number }).id;
  return { root, db, id };
}

describe("看清关节", () => {
  it("边即契约：跨过边界的 import、被调用的符号和只被 import 的类型；没有直接依赖时给出最短链", async () => {
    const { db } = await fixture();
    try {
      const boundary = getBoundary(db, "pkg:@x/service", "pkg:@x/store")!;
      expect(boundary.imports.map((i) => [i.fromPath, i.toPath, i.names.sort(), i.typeOnly, i.bypass])).toEqual([
        ["packages/service/src/index.ts", "packages/store/src/index.ts", ["Item", "loadItems", "makeItem", "saveItem"], false, false],
      ]);
      expect(boundary.symbols.map((s) => [s.name, s.calls, s.importOnly])).toEqual([
        ["loadItems", 1, false],
        ["makeItem", 1, false],
        ["saveItem", 1, false],
        ["Item", 0, true],
      ]);
      expect(boundary.path).toBeNull();

      const indirect = getBoundary(db, "pkg:@x/app", "pkg:@x/store")!;
      expect(indirect.imports).toEqual([]);
      expect(indirect.path?.map((p) => p.path)).toEqual([
        "packages/app/src/main.ts", "packages/service/src/index.ts", "packages/store/src/index.ts",
      ]);
    } finally {
      db.close();
    }
  });

  it("模块名片：对外接口、依赖谁 / 被谁依赖、I/O、测试、接口指纹", async () => {
    const { db } = await fixture();
    try {
      const card = getModuleCard(db, "pkg:@x/service")!;
      expect(card.api.map((a) => [a.name, a.callers])).toEqual([["addAll", 1], ["listOpen", 1]]);
      expect(card.dependsOn.map((d) => [d.id, d.names])).toEqual([["pkg:@x/store", ["Item", "loadItems", "makeItem", "saveItem"]]]);
      expect(card.usedBy.map((d) => [d.id, d.names])).toEqual([["pkg:@x/app", ["addAll", "listOpen"]]]);
      expect(card.tests).toEqual({ functions: 5, covered: 3, cases: 2 });
      // 唯一一次提交改了全部文件：按提交去重是 1，把各文件的次数加起来会是 3
      expect(getModuleCard(db, "dir:packages")?.history).toMatchObject({ commits: 1, recentCommits: 1 });
      expect(card.apiHash).toMatch(/^[0-9a-f]{16}$/);

      const store = getModuleCard(db, "pkg:@x/store")!;
      expect(store.io).toEqual([{ kind: "database", functions: 2 }]);
    } finally {
      db.close();
    }
  });
});

describe("测试即规格与数据骨架", () => {
  it("符号详情带测试覆盖；包的行为规格按测试文件和用例组归好", async () => {
    const { db, id } = await fixture();
    try {
      const add = getSymbolDetail(db, id("add"))!;
      expect(add.tests).toMatchObject({ total: 1, direct: 1 });
      expect(add.tests?.nearest[0]).toMatchObject({ name: "adds an item", suite: "service", depth: 1 });

      const spec = getSpec(db, "pkg:@x/store")!;
      expect(spec.cases).toBe(2);
      expect(spec.files.map((f) => [f.path, f.suites.map((s) => [s.name, s.cases.map((c) => c.name)])])).toEqual([
        ["packages/service/src/index.test.ts", [["service", ["adds an item", "lists open items"]]]],
      ]);
    } finally {
      db.close();
    }
  });

  it("类型流：谁返回、谁接收；骨架里有核心类型和 SQL 读写的表", async () => {
    const { db, id } = await fixture();
    try {
      const flow = getTypeFlow(db, id("Item"))!;
      expect(flow.producers.map((p) => p.name).sort()).toEqual(["add", "listOpen", "loadItems", "makeItem"]);
      expect(flow.consumers.map((p) => p.name)).toEqual(["saveItem"]);
      expect(flow.importers).toBe(1);

      const skeleton = getSkeleton(db);
      expect(skeleton.types[0]).toMatchObject({ name: "Item", uses: 5 });
      expect(skeleton.tables).toEqual([
        {
          name: "items",
          reads: [expect.objectContaining({ name: "loadItems" })],
          writes: [expect.objectContaining({ name: "saveItem" })],
        },
      ]);
    } finally {
      db.close();
    }
  });

  it("走读帧：控制结构、旁路调用折叠、转发函数、SQL 表", async () => {
    const { db, id } = await fixture();
    try {
      const frame = getWalkFrame(db, id("add"))!;
      const byCallee = (name: string) => frame.calls.find((c) => c.callee === name)!;
      expect(byCallee("Error").blocks?.map((b) => [b.k, b.t, b.x])).toEqual([["if", 'title === ""', 1]]);
      expect(byCallee("log")).toMatchObject({ discarded: true, trivial: true });
      expect(byCallee("saveItem")).toMatchObject({ discarded: true });
      expect(byCallee("saveItem").trivial).toBeUndefined();

      const save = getWalkFrame(db, id("saveItem"))!;
      expect(save.calls.find((c) => c.callee === "prepare")?.tables).toEqual([{ name: "items", write: true }]);

      const forward = getWalkFrame(db, id("addAll"))!;
      expect(forward.calls.find((c) => c.callee === "add")?.blocks?.map((b) => b.k)).toEqual(["loop"]);
      const viaForward = getSymbolDetail(db, id("forward"))!;
      expect(viaForward.callees.map((c) => c.name)).toEqual(["add"]);
    } finally {
      db.close();
    }
  });
});

describe("理解账本与导览", () => {
  it("看懂后代码改了就过期；主干覆盖和下一步该读的", async () => {
    const { root, db, id } = await fixture();
    markUnderstood(db, root, `sym:${id("add")}`);
    markUnderstood(db, root, `file:${(db.prepare("SELECT id FROM files WHERE path = 'packages/store/src/index.ts'").get() as { id: number }).id}`);
    const before = getUnderstanding(db, root);
    // 包入口里导出的函数都是公共 API 入口，九个函数全在主干上
    expect(before.summary.key).toEqual({ total: 9, understood: 4, stale: 0 });
    expect(before.next.map((n) => n.name)).not.toContain("add");
    db.close();

    write(root, { "packages/service/src/index.ts": readFileSync(join(root, "packages/service/src/index.ts"), "utf8").replace('log("added");', 'log("added!");') });
    await scanRepo({ root });
    const after = openDb(indexPath(root), { readonly: true });
    try {
      const understanding = getUnderstanding(after, root);
      expect(understanding.stale.map((m) => [m.label, m.status])).toEqual([["add", "stale"]]);
      expect(understanding.next[0]).toMatchObject({ name: "add", stale: true });
      const lens = understandingLens(after, root, ["pkg:@x/store", "pkg:@x/service"]);
      expect(lens["pkg:@x/store"]).toMatchObject({ total: 3, understood: 3, stale: 0 });
      expect(lens["pkg:@x/service"]).toMatchObject({ total: 5, understood: 0, stale: 1 });
      expect(getLens(after, root, "tests", ["pkg:@x/service"])["pkg:@x/service"]).toEqual({ total: 5, covered: 3 });
    } finally {
      after.close();
    }
  });

  it("导览用稳定引用，保存进团队约定后换个扫描照样找得到", async () => {
    const { root, db, id } = await fixture();
    try {
      const generated = listTours(db, root).find((t) => t.id === GENERATED_TOUR_ID)!;
      expect(generated.steps[0]).toMatchObject({ target: "repo", reason: { kind: "overview" } });
      expect(generated.steps.some((s) => s.reason?.kind === "entry" && s.title === "main")).toBe(true);
      expect(stableRef(db, `sym:${id("add")}`)).toBe("symbol:packages/service/src/index.ts#add");
      expect(resolveRef(db, "symbol:packages/service/src/index.ts#add")).toBe(`sym:${id("add")}`);

      const saved = saveTour(db, root, {
        id: GENERATED_TOUR_ID, title: "上手", description: null,
        steps: [{ target: "", nodeId: `sym:${id("add")}`, title: "新增", note: "先看校验" }],
      });
      expect(saved.id).not.toBe(GENERATED_TOUR_ID);
      expect(JSON.parse(readFileSync(join(root, ".repolens.json"), "utf8")).tours).toEqual([
        { id: saved.id, title: "上手", description: null, steps: [{ target: "symbol:packages/service/src/index.ts#add", title: "新增", note: "先看校验" }] },
      ]);
    } finally {
      db.close();
    }
  });
});

describe("守住约定", () => {
  it("check：依赖锁里没有的新依赖、相对基线新增的被拦问题都让检查失败", async () => {
    const { root, db } = await fixture();
    writeLock(root, buildLock(db));
    db.close();
    expect((await runCheck(root)).passed).toBe(true);

    write(root, {
      "packages/store/src/extra.ts": "import { listOpen } from '@x/service';\nexport function extra() { return listOpen(); }\n",
    });
    const report = await runCheck(root, { baseline: "HEAD" });
    expect(report.passed).toBe(false);
    expect(report.unapproved.map((d) => `${d.from} → ${d.to}`)).toEqual(["@x/store → @x/service"]);
    // 新环同时出现在包级和目录级
    expect(report.ratchet?.failed.map((f) => f.kind).sort()).toEqual(["cycle", "cycle", "unapproved"]);
  });

  it("文件详情带 AI 摘要的落地校验所需的源码，和测试覆盖", async () => {
    const { db, root } = await fixture();
    try {
      const file = db.prepare("SELECT id FROM files WHERE path = 'packages/service/src/index.ts'").get() as { id: number };
      const detail = getFileDetail(db, file.id, root)!;
      expect(detail.tests).toEqual({ functions: 5, covered: 3, cases: 2 });
      expect(detail.history).toMatchObject({ commits: 1, recentCommits: 1, authors: 1 });
    } finally {
      db.close();
    }
  });
});
