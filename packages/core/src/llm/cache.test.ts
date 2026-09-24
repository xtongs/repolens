import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db/database.js";
import {
  currentLlmStatus,
  getCachedSemantic,
  invalidateCachedSemantic,
  putCachedSemantic,
  writeLlmStatus,
} from "./cache.js";

let db: Db | null = null;
let dir: string | null = null;

afterEach(() => {
  vi.unstubAllEnvs();
  db?.close();
  db = null;
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = null;
});

describe("currentLlmStatus", () => {
  it("可用性按当前配置和环境变量判断，用量沿用同一模型下的记录", () => {
    dir = mkdtempSync(join(tmpdir(), "repolens-llm-status-"));
    const repo = dir;
    vi.stubEnv("XDG_CONFIG_HOME", join(repo, "xdg"));
    mkdirSync(join(repo, "xdg/repolens"), { recursive: true });
    writeFileSync(
      join(repo, "xdg/repolens/config.json"),
      JSON.stringify({ llm: { apiKeyEnv: "REPOLENS_TEST_LIVE_STATUS_KEY" } }),
    );
    const writeRepoConfig = (model: string) => writeFileSync(
      join(repo, ".repolens.json"),
      JSON.stringify({ llm: { model } }),
    );
    writeRepoConfig("m1");
    db = openDb(join(repo, "index.db"));
    writeLlmStatus(db, {
      enabled: true, available: false, model: "m1", reason: "扫描时的旧原因",
      usage: { requests: 3, inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });

    expect(currentLlmStatus(db, repo)).toMatchObject({
      available: false, reason: "未设置环境变量 REPOLENS_TEST_LIVE_STATUS_KEY", usage: { totalTokens: 15 },
    });

    vi.stubEnv("REPOLENS_TEST_LIVE_STATUS_KEY", "k");
    expect(currentLlmStatus(db, repo)).toMatchObject({
      enabled: true, available: true, reason: null, model: "m1", usage: { totalTokens: 15 },
    });

    writeRepoConfig("m2");
    expect(currentLlmStatus(db, repo)).toMatchObject({ model: "m2", usage: { totalTokens: 0 } });
  });
});

describe("semantic cache", () => {
  it("只命中相同源码指纹并能清掉过期内容", () => {
    dir = mkdtempSync(join(tmpdir(), "repolens-llm-cache-"));
    db = openDb(join(dir, "index.db"));
    putCachedSemantic(db, {
      targetKind: "symbol", targetKey: "src/a.ts#run", flavor: "summary",
      lang: "zh", content: "旧摘要", sourceHash: "hash-a", model: "test",
    });

    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh", "hash-a")?.content).toBe("旧摘要");
    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh", "hash-a", "other-model")).toBeNull();
    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh", "hash-b")).toBeNull();

    invalidateCachedSemantic(db, "symbol", "src/a.ts#run", "hash-b");
    expect(getCachedSemantic(db, "symbol", "src/a.ts#run", "summary", "zh")).toBeNull();
  });
});
