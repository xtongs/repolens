import { describe, expect, it } from "vitest";
import type { LlmConfig } from "../types.js";
import { LlmUnavailableError, OpenAiCompatibleClient, parseJsonResponse } from "./client.js";

const config: LlmConfig = {
  baseUrl: "http://127.0.0.1:8317/v1",
  model: "test-model",
  interactiveModel: null,
  apiKeyEnv: "REPOLENS_TEST_API_KEY_THAT_DOES_NOT_EXIST",
  maxConcurrency: 2,
  temperature: 0.1,
  reasoningEffort: "low",
  maxOutputTokens: 100,
  requestTimeoutMs: 1_000,
  maxRetries: 1,
  scanBatchSize: 4,
  scanMaxCalls: 10,
  outputLanguage: "zh",
  enabled: true,
};

describe("OpenAiCompatibleClient", () => {
  it("在需要 key 但环境变量缺失时优雅拒绝", () => {
    expect(() => new OpenAiCompatibleClient(config)).toThrow(LlmUnavailableError);
  });

  it("支持无需鉴权的 Ollama 风格配置", async () => {
    const calls: RequestInit[] = [];
    const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      calls.push(init ?? {});
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: '```json\n{"summary":"ok"}\n```' } }],
          usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const client = new OpenAiCompatibleClient(
      { ...config, apiKeyEnv: "", baseUrl: "http://localhost:11434/v1" },
      { fetch: fetch as typeof globalThis.fetch },
    );
    const result = await client.completeJson<{ summary: string }>("system", "user");
    expect(result.data.summary).toBe("ok");
    expect(result.usage).toEqual({ requests: 1, inputTokens: 7, outputTokens: 3, totalTokens: 10 });
    expect((calls[0]?.headers as Record<string, string>)["authorization"]).toBeUndefined();
  });

  it("对 429 重试且不在错误中泄露鉴权头", async () => {
    let count = 0;
    const fetch = async () => {
      count++;
      if (count === 1) return new Response(JSON.stringify({ error: { message: "busy" } }), { status: 429 });
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' } }] }), { status: 200 });
    };
    const client = new OpenAiCompatibleClient(config, { apiKey: "super-secret", fetch: fetch as typeof globalThis.fetch });
    await expect(client.completeJson<{ ok: boolean }>("s", "u")).resolves.toMatchObject({ data: { ok: true } });
    expect(count).toBe(2);
  });
});

describe("parseJsonResponse", () => {
  it("兼容代码围栏和前后解释文本", () => {
    expect(parseJsonResponse<{ a: number }>("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(parseJsonResponse<{ a: number }>("结果如下： {\"a\":2} 完成")).toEqual({ a: 2 });
  });
});
