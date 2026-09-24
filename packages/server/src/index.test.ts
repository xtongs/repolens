import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ACCESS_TOKEN_COOKIE, ACCESS_TOKEN_HEADER, startServer, type RunningServer } from "./index.js";

let home: string;
let server: RunningServer | null = null;

// 仓库清单在 ~/.repolens/repos.json，os.homedir() 在 POSIX 上读 $HOME
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
});
