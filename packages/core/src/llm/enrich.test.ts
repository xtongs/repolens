import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db/database.js";
import { getFileDetail } from "../db/queries.js";
import { getCachedSemantic, putCachedSemantic } from "./cache.js";
import { generateFileSummary } from "./enrich.js";

let db: Db | null = null;
const temporaryDirectories: string[] = [];

afterEach(() => {
  db?.close();
  db = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of temporaryDirectories.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

describe("generateFileSummary", () => {
  it("生成结构化通俗摘要、清理 HTML 实体并使用新版缓存", async () => {
    const repo = tempDir("repolens-summary-repo-");
    const configHome = tempDir("repolens-summary-config-");
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src/example.ts"), "export function run() { return 'ok'; }\n");
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      llm: {
        baseUrl: "http://llm.test/v1",
        model: "test-model",
        apiKeyEnv: "REPOLENS_ENRICH_TEST_KEY",
        maxRetries: 0,
      },
    }));
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    vi.stubEnv("REPOLENS_ENRICH_TEST_KEY", "test-secret");

    db = openDb(join(repo, "index.db"));
    const inserted = db.prepare(
      `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run("src/example.ts", "src", "example.ts", "typescript", "source", 1, 39, "file-hash");
    const fileId = Number(inserted.lastInsertRowid);
    putCachedSemantic(db, {
      targetKind: "file", targetKey: "src/example.ts", flavor: "summary", lang: "zh",
      content: "旧版晦涩摘要", sourceHash: "file-hash", model: "test-model",
    });

    // 老 flavor 仍可供扫描期包/目录使用，但不能污染新版文件摘要。
    expect(getFileDetail(db, fileId)?.summary).toBeNull();

    const calls: Array<{ system: string; authorization: string | null }> = [];
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ role: string; content: string }> };
      calls.push({
        system: body.messages.find((message) => message.role === "system")?.content ?? "",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      const summary = calls.length === 1
        ? "用途：处理请求。&#x20;\n\n核心概念：Span（一次可追踪的操作）。&nbsp;\n\n工作方式：接收输入并返回结果。"
        : "用途：这是手动刷新后生成的新摘要。";
      return new Response(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({ summary }),
          },
        }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const first = await generateFileSummary(db, repo, fileId);
    expect(first).toMatchObject({
      generated: true, cacheHit: false, model: "test-model",
      summary: "用途：处理请求。\n\n核心概念：Span（一次可追踪的操作）。\n\n工作方式：接收输入并返回结果。",
    });
    expect(first.summary).not.toContain("&#x20;");
    expect(first.summary).not.toContain("&nbsp;");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.authorization).toBe("Bearer test-secret");
    expect(calls[0]?.system).toContain("用途：");
    expect(calls[0]?.system).toContain("核心概念：");
    expect(calls[0]?.system).toContain("专业术语首次出现时");
    expect(calls[0]?.system).toContain("为什么需要");
    expect(calls[0]?.system).toContain("不要暗示耗时统计");

    expect(getCachedSemantic(
      db, "file", "src/example.ts", "summary-v2", "zh", "file-hash", "test-model",
    )?.content).toBe(first.summary);
    expect(getFileDetail(db, fileId)?.summary).toBe(first.summary);

    const second = await generateFileSummary(db, repo, fileId);
    expect(second).toMatchObject({ generated: false, cacheHit: true, summary: first.summary });
    expect(calls).toHaveLength(1);

    const refreshed = await generateFileSummary(db, repo, fileId, { force: true });
    expect(refreshed).toMatchObject({
      generated: true, cacheHit: false, summary: "用途：这是手动刷新后生成的新摘要。",
    });
    expect(calls).toHaveLength(2);
    expect(getFileDetail(db, fileId)?.summary).toBe(refreshed.summary);
  });
});
