import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanRepo } from "../pipeline/scan.js";
import { buildBaseline } from "./baseline.js";
import { buildChangeReport } from "./report.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-diff-config-"));
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

function git(root: string, ...args: string[]): void {
  execFileSync("git", ["-C", root, "-c", "user.email=t@example.com", "-c", "user.name=t", ...args], { stdio: "ignore" });
}

function repoAtBase(): string {
  const root = mkdtempSync(join(tmpdir(), "repolens-diff-"));
  roots.push(root);
  write(root, {
    ".repolens.json": JSON.stringify({ llm: { enabled: false } }),
    "package.json": JSON.stringify({ name: "diff-fixture", type: "module" }),
    "src/api.ts": `
      import { load } from "./store";
      const app = { get(p: string, h: unknown): void {}, post(p: string, h: unknown): void {} };
      export function getItem(id: string) { return load(id); }
      app.get("/items/:id", getItem);
    `,
    "src/store.ts": `
      import { readFileSync } from "node:fs";
      export function load(id: string) { return readFileSync(id, "utf8"); }
      export function unused() { return 1; }
    `,
    "src/util/format.ts": "export function fmt(x: string) { return x.trim(); }\n",
    "src/helpers.ts": "export function clamp(n: number) { return Math.max(0, n); }\n",
  });
  git(root, "init", "-q");
  git(root, "add", "-A");
  git(root, "commit", "-qm", "base");
  return root;
}

describe("变更视角", () => {
  it("对比工作区与基线提交：文件、符号、依赖、外部库、入口与影响面", async () => {
    const root = repoAtBase();
    write(root, {
      "src/api.ts": `
        import { z } from "zod";
        import { load, save } from "./store";
        import { fmt } from "./util/format";
        const app = { get(p: string, h: unknown): void {}, post(p: string, h: unknown): void {} };
        export function getItem(id: string) { return load(fmt(id)); }
        export function createItem(body: string) { return save(z.string().parse(body)); }
        app.get("/items/:id", getItem);
        app.post("/items", createItem);
      `,
      "src/store.ts": `
        import { readFileSync, writeFileSync } from "node:fs";
        export function load(id: string) { return readFileSync(id, "utf8").toUpperCase(); }
        export function save(body: string) { writeFileSync("out.txt", body); }
      `,
      "src/lib/helpers.ts": "export function clamp(n: number) { return Math.max(0, n); }\n",
    });
    unlinkSync(join(root, "src/helpers.ts"));
    await scanRepo({ root });

    const report = await buildChangeReport(root, { base: "HEAD" });
    expect(report.base.ref).toBe("HEAD");
    expect(report.head).toBeNull();

    expect(report.files.map((f) => [f.status, f.path, f.from ?? null])).toEqual([
      ["modified", "src/api.ts", null],
      ["modified", "src/store.ts", null],
      ["moved", "src/lib/helpers.ts", "src/helpers.ts"],
    ]);

    const symbols = report.symbols.map((s) => [s.status, `${s.path}:${s.name}`]);
    expect(symbols).toEqual(expect.arrayContaining([
      ["modified", "src/api.ts:getItem"],
      ["added", "src/api.ts:createItem"],
      ["modified", "src/store.ts:load"],
      ["added", "src/store.ts:save"],
      ["removed", "src/store.ts:unused"],
    ]));
    expect(report.symbols.find((s) => s.name === "load")).toMatchObject({ shapeChanged: true, callers: 1, exported: true });
    expect(report.symbols.find((s) => s.name === "unused")).toMatchObject({ id: null, callers: 0 });

    expect(report.dependencies).toEqual([
      { status: "added", level: "directory", source: "src", target: "src/util", type: "imports", count: 1 },
    ]);
    expect(report.externals).toEqual({ added: ["zod"], removed: [] });

    expect(report.entries.map((e) => [e.status, e.label])).toEqual(expect.arrayContaining([
      ["added", "POST /items"],
      ["affected", "GET /items/:id"],
    ]));
    const affected = report.entries.find((e) => e.label === "GET /items/:id");
    expect(affected?.via.map((v) => [v.name, v.depth])).toEqual([["getItem", 0], ["load", 1]]);
  });

  it("基线按提交缓存；子目录扫描根在旧提交里不存在时基线为空", async () => {
    const root = repoAtBase();
    const first = await buildBaseline(root, "HEAD");
    const again = await buildBaseline(root, "HEAD");
    expect(first.reused).toBe(false);
    expect(again).toMatchObject({ reused: true, commit: first.commit, dbPath: first.dbPath });
    expect(existsSync(first.dbPath)).toBe(true);

    write(root, { "apps/new/src/main.ts": "export function main() { return 1; }\n" });
    const sub = join(root, "apps/new");
    await scanRepo({ root: sub });
    const report = await buildChangeReport(sub, { base: "HEAD" });
    expect(report.files.map((f) => [f.status, f.path])).toEqual([["added", "src/main.ts"]]);
  });

  it("不是 git 仓库或找不到提交时给出可读的错误", async () => {
    const plain = mkdtempSync(join(tmpdir(), "repolens-diff-plain-"));
    roots.push(plain);
    await expect(buildBaseline(plain, "HEAD")).rejects.toThrow("不是 git 仓库");
    const root = repoAtBase();
    await expect(buildBaseline(root, "no-such-branch")).rejects.toThrow("找不到提交 no-such-branch");
  });
});
