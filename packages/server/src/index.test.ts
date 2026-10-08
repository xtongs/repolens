import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanRepo } from "@repolens/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_HEADER, startServer, type RunningServer } from "./index.js";

let home: string;
let server: RunningServer | null = null;

// 仓库清单在 ~/.repolens/repos.json，os.homedir() 在 POSIX 上读 $HOME，Windows 上读 %USERPROFILE%
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "repolens-server-home-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
});

afterEach(async () => {
  await server?.close();
  server = null;
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

describe("startServer", () => {
  it("不指定仓库也能启动，缺省请求提示先打开仓库", async () => {
    server = await startServer({ repoRoot: null, port: 0 });
    expect(server.port).toBeGreaterThan(0);
    expect(server.url).toBe(`http://127.0.0.1:${server.port}`);

    expect(await (await fetch(`${server.url}/api/repos`)).json()).toEqual({ current: null, repos: [] });
    const overview = await fetch(`${server.url}/api/overview`);
    expect(overview.status).toBe(404);
    expect(await overview.json()).toEqual({ error: "还没有打开任何仓库" });
  });

  it("设置访问令牌后接口只接受带令牌的请求，静态页面不受影响", async () => {
    const webRoot = join(home, "web");
    mkdirSync(webRoot);
    writeFileSync(join(webRoot, "index.html"), "<!doctype html><title>RepoLens</title>");
    server = await startServer({ repoRoot: null, port: 0, webRoot, accessToken: "secret-token" });
    const status = async (headers: Record<string, string> = {}) =>
      (await fetch(`${server!.url}/api/repos`, { headers })).status;

    expect(await status()).toBe(401);
    expect(await status({ [ACCESS_TOKEN_HEADER]: "secret-tokeX" })).toBe(401);
    expect(await status({ [ACCESS_TOKEN_HEADER]: "secret-token" })).toBe(200);
    expect(await status({ cookie: `${ACCESS_TOKEN_COOKIE}=secret-token` })).toBe(200);
    expect((await fetch(`${server.url}/`)).status).toBe(200);
    expect(await (await fetch(`${server.url}/some/spa/route`)).text()).toContain("<title>RepoLens</title>");
  });

  it("目录选择器可以由调用方替换", async () => {
    const pickDirectory = vi.fn(async () => null);
    server = await startServer({ repoRoot: null, port: 0, pickDirectory });
    const response = await fetch(`${server.url}/api/repos/pick-and-scan`, {
      method: "POST",
      headers: { "x-repolens-intent": "scan-repository" },
    });
    expect(await response.json()).toEqual({ cancelled: true });
    expect(pickDirectory).toHaveBeenCalledOnce();
  });

  it("笔记写请求必须带意图标记，保存后按路径读回；仓库挪过位置也写在新位置", async () => {
    const scanned = join(home, "scanned");
    mkdirSync(join(scanned, "src"), { recursive: true });
    writeFileSync(join(scanned, "src/a.ts"), "export function a() {\n  return 1;\n}\n");
    await scanRepo({ root: scanned });
    const repo = join(home, "repo");
    renameSync(scanned, repo);
    server = await startServer({ repoRoot: repo, port: 0 });
    const hit = (await (await fetch(`${server.url}/api/search?q=a.ts`)).json()) as Array<{ id: string }>;
    const fileId = hit.find((item) => item.id.startsWith("file:"))!.id;
    const save = (headers: Record<string, string>) =>
      fetch(`${server!.url}/api/notes`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ nodeId: fileId, lines: [2, 2], text: "返回 1" }),
      });

    expect((await save({})).status).toBe(403);
    const saved = (await (await save({ "x-repolens-intent": "save-note" })).json()) as { id: string };
    const listed = await (await fetch(`${server.url}/api/notes`)).json();
    expect(listed).toMatchObject({
      notes: [{ id: saved.id, nodeId: fileId, target: { kind: "file", path: "src/a.ts", lines: [2, 2] } }],
    });
    expect(existsSync(join(repo, ".repolens", "notes.json"))).toBe(true);
    expect(existsSync(scanned)).toBe(false);

    const remove = (headers: Record<string, string>) =>
      fetch(`${server!.url}/api/notes/${saved.id}`, { method: "DELETE", headers });
    expect((await remove({})).status).toBe(403);
    expect((await remove({ "x-repolens-intent": "save-note" })).status).toBe(200);
    expect(await (await fetch(`${server.url}/api/notes`)).json()).toEqual({ notes: [] });
  });

  it("变更对比要求意图标记；非 git 仓库和可疑的提交写法返回 400", async () => {
    const repo = join(home, "plain");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const compare = (base: string, headers: Record<string, string> = { "x-repolens-intent": "compare-changes" }) =>
      fetch(`${server!.url}/api/changes?base=${encodeURIComponent(base)}`, { method: "POST", headers });

    expect((await compare("HEAD", {})).status).toBe(403);
    const plain = await compare("HEAD");
    expect(plain.status).toBe(400);
    expect(await plain.json()).toEqual({ error: "不是 git 仓库，没法按提交对比" });
    const injected = await compare("--output=/tmp/x");
    expect(injected.status).toBe(400);
    expect(((await injected.json()) as { error: string }).error).toMatch(/^不支持的提交写法/);
  });

  it("README 跟着扫描入索引，按包或目录读回；没有时返回 null", async () => {
    const repo = join(home, "readme");
    mkdirSync(join(repo, "src"), { recursive: true });
    writeFileSync(join(repo, "README.md"), "# Demo\n\nWhy this repo exists.\n");
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const readme = (node: string) =>
      fetch(`${server!.url}/api/readme?node=${encodeURIComponent(node)}`).then((response) => response.json());

    expect(await readme("dir:.")).toMatchObject({
      path: "README.md", format: "markdown", content: "# Demo\n\nWhy this repo exists.\n", truncated: false,
    });
    expect(await readme("dir:src")).toBeNull();
  });

  it("结构树按磁盘列出没进索引的文件，原文可读；越界路径返回 400", async () => {
    const repo = join(home, "files");
    mkdirSync(join(repo, "dist"), { recursive: true });
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, ".gitignore"), "dist/\n");
    writeFileSync(join(repo, "dist/out.js"), "console.log(1);\n");
    writeFileSync(join(repo, "src/a.ts"), "export function a() { return 1; }\n");
    await scanRepo({ root: repo });
    server = await startServer({ repoRoot: repo, port: 0 });
    const get = (path: string) => fetch(`${server!.url}/api${path}`);

    const tree = (await (await get("/files?path=.")).json()) as { children: Array<Record<string, unknown>> };
    expect(tree.children.find((node) => node.name === "src")).toMatchObject({ status: "analyzed" });
    expect(tree.children.find((node) => node.name === "dist")).toMatchObject({
      id: "raw:dist", status: "excluded", excludedBy: "ignored",
    });
    expect(await (await get("/raw?path=dist/out.js")).json()).toMatchObject({ code: "console.log(1);\n" });
    const escaped = await get(`/raw?path=${encodeURIComponent("../files/src/a.ts")}`);
    expect(escaped.status).toBe(400);
    expect(await escaped.json()).toEqual({ error: "非法的路径" });
  });
});
