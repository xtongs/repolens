import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDb, type Db } from "../db/database.js";
import type { ChatContextItemDto } from "../types.js";
import { readLlmStatus } from "./cache.js";
import { buildChatContext, parseChatRequest, recordChatUsage, streamRepositoryChat } from "./chat.js";

let db: Db | null = null;
const temporaryDirectories: string[] = [];

afterEach(() => {
  db?.close();
  db = null;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const path of temporaryDirectories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

function setupRepo(): { repo: string; db: Db; fileId: number; symbolId: number } {
  const repo = tempDir("repolens-chat-repo-");
  const configHome = tempDir("repolens-chat-config-");
  mkdirSync(join(repo, "src"));
  const source = "// header\n\nexport function run(input) {\n  if (!input) return null;\n  return input.trim();\n}\n";
  writeFileSync(join(repo, "src/run.ts"), source);
  mkdirSync(join(configHome, "repolens"));
  writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
    llm: { baseUrl: "http://llm.test/v1", model: "chat-model", apiKeyEnv: "REPOLENS_CHAT_TEST_KEY", maxRetries: 0 },
  }));
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
  vi.stubEnv("REPOLENS_CHAT_TEST_KEY", "test-secret");

  const opened = openDb(join(repo, "index.db"));
  const fileId = Number(opened.prepare(
    `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
     VALUES ('src/run.ts', 'src', 'run.ts', 'typescript', 'source', 6, ?, 'file-hash')`,
  ).run(Buffer.byteLength(source)).lastInsertRowid);
  const symbolId = Number(opened.prepare(
    `INSERT INTO symbols (file_id, name, kind, exported, start_line, end_line, start_byte, end_byte, hash)
     VALUES (?, 'run', 'function', 1, 3, 6, ?, ?, 'sym-hash')`,
  ).run(fileId, source.indexOf("export"), source.lastIndexOf("}") + 1).lastInsertRowid);
  db = opened;
  return { repo, db: opened, fileId, symbolId };
}

describe("parseChatRequest", () => {
  it("要求最后一条是非空的用户消息", () => {
    expect(parseChatRequest(null)).toBeNull();
    expect(parseChatRequest({ messages: [] })).toBeNull();
    expect(parseChatRequest({ messages: [{ role: "assistant", content: "hi" }] })).toBeNull();
    expect(parseChatRequest({ messages: [{ role: "user", content: "   " }] })).toBeNull();
    expect(parseChatRequest({ messages: [{ role: "system", content: "x" }] })).toBeNull();
  });

  it("丢弃不合法的引用，不接受路径形式的 id", () => {
    const parsed = parseChatRequest({
      messages: [{
        role: "user",
        content: "这是做什么的？",
        refs: [
          { kind: "node", id: "sym:12" },
          { kind: "node", id: "file:../../etc/passwd" },
          { kind: "node", id: "dir:src/db" },
          { kind: "quote", text: "  " },
          { kind: "quote", text: "返回结果", nodeId: "file:3", lines: [9, 4] },
          { kind: "view", mode: "hack" },
          { kind: "view", mode: "trace", traceId: "trace:7" },
        ],
      }],
    });
    expect(parsed?.messages[0]?.refs).toEqual([
      { kind: "node", id: "sym:12" },
      { kind: "node", id: "dir:src/db" },
      { kind: "quote", text: "返回结果", nodeId: "file:3", lines: null },
      { kind: "view", mode: "trace", scope: null, expanded: null, traceId: "trace:7" },
    ]);
  });

  it("只保留最近的消息并截断过长内容", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));
    messages.push({ role: "user", content: "x".repeat(20_000) });
    const parsed = parseChatRequest({ messages });
    expect(parsed?.messages).toHaveLength(24);
    expect(parsed?.messages.at(-1)?.content).toHaveLength(8_000);
  });
});

describe("buildChatContext", () => {
  it("按 id 现读源码并带上可引用的节点 id", () => {
    const { repo, db, symbolId } = setupRepo();
    const context = buildChatContext(db, repo, [
      { role: "user", content: "run 做什么？", refs: [{ kind: "node", id: `sym:${symbolId}` }] },
    ]);
    expect(context.text).toContain(`## 符号 run（id=sym:${symbolId}）`);
    expect(context.text).toContain("3| export function run(input) {");
    expect(context.text).toContain("6| }");
    expect(context.items.map((item) => item.label)).toEqual(["repo", "run"]);
  });

  it("被调用方标注定义文件，调用点行号归到当前文件", () => {
    const { repo, db, symbolId } = setupRepo();
    const utilFile = Number(db.prepare(
      `INSERT INTO files (path, dir_path, name, language, role, loc, bytes, hash)
       VALUES ('src/util.ts', 'src', 'util.ts', 'typescript', 'source', 40, 0, 'util-hash')`,
    ).run().lastInsertRowid);
    const trim = Number(db.prepare(
      `INSERT INTO symbols (file_id, name, kind, exported, start_line, end_line, start_byte, end_byte, hash)
       VALUES (?, 'trim', 'function', 1, 30, 32, 0, 0, 'trim-hash')`,
    ).run(utilFile).lastInsertRowid);
    db.prepare(
      `INSERT INTO edges (type, src_kind, src_id, dst_kind, dst_id, confidence, line)
       VALUES ('calls', 'symbol', ?, 'symbol', ?, 'exact', 5)`,
    ).run(symbolId, trim);

    const context = buildChatContext(db, repo, [
      { role: "user", content: "run 调用了什么？", refs: [{ kind: "node", id: `sym:${symbolId}` }] },
    ]);
    expect(context.text).toContain(`trim（id=sym:${trim}，定义在 src/util.ts，本文件 L5 调用）`);
    expect(context.text).not.toContain("src/util.ts:5");
  });

  it("不存在的节点静默跳过，重复引用只展开一次", () => {
    const { repo, db, fileId } = setupRepo();
    const context = buildChatContext(db, repo, [
      { role: "user", content: "a", refs: [{ kind: "node", id: `file:${fileId}` }, { kind: "node", id: "sym:999" }] },
      { role: "assistant", content: "b" },
      { role: "user", content: "c", refs: [{ kind: "node", id: `file:${fileId}` }] },
    ]);
    expect(context.items.map((item) => item.nodeId ?? null)).toEqual([null, `file:${fileId}`]);
    expect(context.text.match(/## 文件 src\/run.ts/g)).toHaveLength(1);
  });
});

describe("streamRepositoryChat", () => {
  it("把上下文放进 system、引用放进用户消息，并流式回传", async () => {
    const { repo, db, fileId, symbolId } = setupRepo();
    let sent: { messages: Array<{ role: string; content: string }>; stream: boolean } | null = null;
    vi.stubGlobal("fetch", async (_input: string | URL | Request, init?: RequestInit) => {
      sent = JSON.parse(String(init?.body)) as typeof sent;
      const encoder = new TextEncoder();
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(`data: {"choices":[{"delta":{"content":"它会[清理输入](node:sym:${symbolId})"}}]}\n\n`));
          controller.enqueue(encoder.encode('data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":8,"total_tokens":108}}\n\n'));
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        },
      }), { status: 200, headers: { "content-type": "text/event-stream" } });
    });

    let items: ChatContextItemDto[] = [];
    let answer = "";
    const done = await streamRepositoryChat(db, repo, {
      messages: [{
        role: "user",
        content: "为什么要 trim？",
        refs: [{ kind: "quote", text: "返回去掉首尾空白的输入", nodeId: `file:${fileId}`, lines: [5, 5] }],
      }],
    }, {
      onContext: (value) => { items = value; },
      onDelta: (text) => { answer += text; },
    });

    expect(answer).toBe(`它会[清理输入](node:sym:${symbolId})`);
    expect(done).toEqual({ model: "chat-model", usage: { requests: 1, inputTokens: 100, outputTokens: 8, totalTokens: 108 } });
    expect(items.map((item) => item.detail)).toContain("L5–5");

    const request = sent as unknown as { messages: Array<{ role: string; content: string }>; stream: boolean };
    expect(request.stream).toBe(true);
    expect(request.messages[0]?.role).toBe("system");
    expect(request.messages[0]?.content).toContain("[显示名](node:ID)");
    expect(request.messages[0]?.content).toContain("5|   return input.trim();");
    expect(request.messages[1]).toEqual({
      role: "user",
      content: `[引用 · id=file:${fileId} L5–5]\n> 返回去掉首尾空白的输入\n\n为什么要 trim？`,
    });

    recordChatUsage(db, repo, done.usage);
    expect(readLlmStatus(db)?.usage.totalTokens).toBe(108);
  });
});
