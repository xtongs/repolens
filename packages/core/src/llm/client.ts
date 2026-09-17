import type { LlmConfig, LlmUsage } from "../types.js";

export class LlmUnavailableError extends Error {
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "LlmUnavailableError";
  }
}

export class LlmResponseError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "LlmResponseError";
  }
}

export interface CompletionResult<T> {
  data: T;
  usage: LlmUsage;
}

export interface CompletionOptions {
  maxOutputTokens?: number | undefined;
}

export interface LlmClientOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string | undefined;
}

/**
 * 最小 OpenAI Chat Completions 客户端。
 *
 * 不依赖厂商 SDK：Ollama、traex-bridge 和各类自定义网关只要实现
 * `/chat/completions` 就能直接用，也避免把 Node 专属 SDK带进 web 依赖图。
 */
export class OpenAiCompatibleClient {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly apiKey: string;
  private readonly slots: Semaphore;

  constructor(
    readonly config: LlmConfig,
    options: LlmClientOptions = {},
  ) {
    if (!config.enabled) throw new LlmUnavailableError("LLM 已在配置中关闭");

    const apiKey =
      options.apiKey ??
      (config.apiKeyEnv.trim() === "" ? "" : process.env[config.apiKeyEnv]?.trim());
    if (apiKey === undefined || (apiKey === "" && config.apiKeyEnv.trim() !== "")) {
      throw new LlmUnavailableError(`未设置环境变量 ${config.apiKeyEnv}`);
    }

    this.apiKey = apiKey;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    const semaphoreKey = `${config.baseUrl}\0${config.model}\0${config.maxConcurrency}`;
    this.slots = sharedSemaphores.get(semaphoreKey) ?? new Semaphore(config.maxConcurrency);
    sharedSemaphores.set(semaphoreKey, this.slots);
  }

  async completeJson<T>(
    system: string,
    user: string,
    options: CompletionOptions = {},
  ): Promise<CompletionResult<T>> {
    const release = await this.slots.acquire();
    try {
      const body = await this.requestWithRetry(system, user, options);
      const content = completionContent(body);
      return {
        data: parseJsonResponse<T>(content),
        usage: responseUsage(body),
      };
    } finally {
      release();
    }
  }

  private async requestWithRetry(
    system: string,
    user: string,
    options: CompletionOptions,
  ): Promise<Record<string, unknown>> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.requestTimeoutMs);
      try {
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (this.apiKey !== "") headers["authorization"] = `Bearer ${this.apiKey}`;

        const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers,
          signal: controller.signal,
          body: JSON.stringify({
            model: this.config.model,
            messages: [
              { role: "system", content: system },
              { role: "user", content: user },
            ],
            temperature: this.config.temperature,
            ...(this.config.reasoningEffort === null
              ? {}
              : { reasoning_effort: this.config.reasoningEffort }),
            max_tokens: Math.min(
              this.config.maxOutputTokens,
              Math.max(64, options.maxOutputTokens ?? this.config.maxOutputTokens),
            ),
          }),
        });

        const text = await response.text();
        if (!response.ok) {
          const message = safeApiError(text) ?? `LLM HTTP ${response.status}`;
          const error = new LlmResponseError(message, response.status);
          if (!retryableStatus(response.status) || attempt === this.config.maxRetries) throw error;
          lastError = error;
        } else {
          const parsed = JSON.parse(text) as unknown;
          if (typeof parsed !== "object" || parsed === null) {
            throw new LlmResponseError("LLM 返回的响应不是 JSON 对象", response.status);
          }
          return parsed as Record<string, unknown>;
        }
      } catch (err) {
        const error = normalizeError(err, this.config.requestTimeoutMs);
        if (!retryableError(error) || attempt === this.config.maxRetries) throw error;
        lastError = error;
      } finally {
        clearTimeout(timer);
      }

      await sleep(Math.min(2_000, 200 * 2 ** attempt));
    }

    throw lastError ?? new LlmResponseError("LLM 请求失败", null);
  }
}

function completionContent(body: Record<string, unknown>): string {
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new LlmResponseError("LLM 响应缺少 choices", 200);
  }
  const choice = choices[0];
  const message = typeof choice === "object" && choice !== null ? choice["message"] : null;
  const content =
    typeof message === "object" && message !== null ? message["content"] : undefined;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof part["text"] === "string"
          ? part["text"]
          : "",
      )
      .join("");
  }
  throw new LlmResponseError("LLM 响应缺少文本 content", 200);
}

export function parseJsonResponse<T>(content: string): T {
  const trimmed = content.trim();
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();

  try {
    return JSON.parse(unfenced) as T;
  } catch {
    // 一些兼容网关会无视「只返回 JSON」并在前后加解释，取最外层对象兜底。
    const start = Math.min(...[unfenced.indexOf("{"), unfenced.indexOf("[")].filter((i) => i >= 0));
    const objectEnd = unfenced.lastIndexOf("}");
    const arrayEnd = unfenced.lastIndexOf("]");
    const end = Math.max(objectEnd, arrayEnd);
    if (Number.isFinite(start) && start >= 0 && end > start) {
      try {
        return JSON.parse(unfenced.slice(start, end + 1)) as T;
      } catch {
        // 交给下面的统一错误
      }
    }
    throw new LlmResponseError("LLM 没有返回可解析的 JSON", 200);
  }
}

function responseUsage(body: Record<string, unknown>): LlmUsage {
  const usage = body["usage"];
  const value = typeof usage === "object" && usage !== null ? usage : {};
  const input = numberField(value, "prompt_tokens") || numberField(value, "input_tokens");
  const output =
    numberField(value, "completion_tokens") || numberField(value, "output_tokens");
  const total = numberField(value, "total_tokens") || input + output;
  return { requests: 1, inputTokens: input, outputTokens: output, totalTokens: total };
}

function numberField(value: object, key: string): number {
  const found = (value as Record<string, unknown>)[key];
  return typeof found === "number" && Number.isFinite(found) ? found : 0;
}

function safeApiError(text: string): string | null {
  try {
    const body = JSON.parse(text) as Record<string, unknown>;
    const error = body["error"];
    if (typeof error === "string") return error.slice(0, 500);
    if (typeof error === "object" && error !== null) {
      const message = (error as Record<string, unknown>)["message"];
      if (typeof message === "string") return message.slice(0, 500);
    }
  } catch {
    // 非 JSON 错误页只保留短文本，绝不把响应头（可能含凭据）拼进异常
  }
  const compact = text.trim().replace(/\s+/g, " ");
  return compact === "" ? null : compact.slice(0, 500);
}

function normalizeError(error: unknown, timeoutMs: number): Error {
  if (error instanceof LlmResponseError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmResponseError(`LLM 请求超过 ${timeoutMs}ms`, null);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryableError(error: Error): boolean {
  return !(error instanceof LlmResponseError) || error.status === null || retryableStatus(error.status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active--;
      this.waiters.shift()?.();
    };
  }
}

const sharedSemaphores = new Map<string, Semaphore>();

export function emptyUsage(): LlmUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsage(target: LlmUsage, value: LlmUsage): void {
  target.requests += value.requests;
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.totalTokens += value.totalTokens;
}
