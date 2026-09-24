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

export interface ChatTurn {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface StreamOptions extends CompletionOptions {
  signal?: AbortSignal | undefined;
  onDelta: (text: string) => void;
}

export interface StreamResult {
  content: string;
  usage: LlmUsage;
}

export interface LlmClientOptions {
  fetch?: typeof globalThis.fetch;
  apiKey?: string | undefined;
}

/**
 * 最小 OpenAI Chat Completions 客户端。
 *
 * 不依赖厂商 SDK：Ollama、vLLM 和各类自定义网关只要实现
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
    const reason = llmUnavailableReason(config, options.apiKey);
    if (reason !== null) throw new LlmUnavailableError(reason);

    this.apiKey = options.apiKey ?? envApiKey(config) ?? "";
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

  /**
   * 流式对话，给交互式追问用。
   *
   * 不占后台批量任务的并发槽：用户在等回答时不该排在几百个摘要请求后面。
   * 只在收到首个字节之前重试——已经吐给界面的内容无法撤回，中途断流
   * 直接报错，由用户决定是否重问。
   */
  async streamChat(messages: ChatTurn[], options: StreamOptions): Promise<StreamResult> {
    const { response, controller, idle } = await this.openStream(messages, options);
    try {
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.includes("text/event-stream") || response.body === null) {
        // 部分网关忽略 stream 参数，仍然一次性返回完整 JSON
        const text = await response.text();
        const body = parseJsonObject(text, response.status);
        const content = completionContent(body);
        if (content !== "") options.onDelta(content);
        return { content, usage: responseUsage(body) };
      }
      return await readEventStream(response.body, options.onDelta, idle);
    } catch (err) {
      throw normalizeError(err, this.config.requestTimeoutMs, options.signal);
    } finally {
      idle.stop();
      controller.abort();
    }
  }

  private async openStream(
    messages: ChatTurn[],
    options: StreamOptions,
  ): Promise<{ response: Response; controller: AbortController; idle: IdleTimer }> {
    let lastError: Error | null = null;
    let includeUsage = true;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (options.signal?.aborted) throw abortError();
      const controller = new AbortController();
      const forwardAbort = () => controller.abort();
      options.signal?.addEventListener("abort", forwardAbort, { once: true });
      const idle = new IdleTimer(this.config.requestTimeoutMs, () => controller.abort());
      try {
        const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: { ...this.headers(), accept: "text/event-stream" },
          signal: controller.signal,
          body: JSON.stringify({
            ...this.requestBody(messages, options),
            stream: true,
            ...(includeUsage ? { stream_options: { include_usage: true } } : {}),
          }),
        });
        if (response.ok) return { response, controller, idle };

        const text = await response.text();
        const error = new LlmResponseError(safeApiError(text) ?? `LLM HTTP ${response.status}`, response.status);
        if (includeUsage && (response.status === 400 || response.status === 422) && /stream_options/i.test(text)) {
          // 较老的兼容网关不认识 stream_options；去掉后重发一次，不计入重试次数
          includeUsage = false;
          attempt--;
          idle.stop();
          continue;
        }
        if (!retryableStatus(response.status) || attempt === this.config.maxRetries) throw error;
        lastError = error;
      } catch (err) {
        const error = normalizeError(err, this.config.requestTimeoutMs, options.signal);
        if (options.signal?.aborted || !retryableError(error) || attempt === this.config.maxRetries) {
          idle.stop();
          throw error;
        }
        lastError = error;
      } finally {
        options.signal?.removeEventListener("abort", forwardAbort);
      }
      idle.stop();
      await sleep(Math.min(2_000, 200 * 2 ** attempt));
    }

    throw lastError ?? new LlmResponseError("LLM 请求失败", null);
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey !== "") headers["authorization"] = `Bearer ${this.apiKey}`;
    return headers;
  }

  private requestBody(messages: ChatTurn[], options: CompletionOptions): Record<string, unknown> {
    return {
      model: this.config.model,
      messages,
      temperature: this.config.temperature,
      ...(this.config.reasoningEffort === null ? {} : { reasoning_effort: this.config.reasoningEffort }),
      max_tokens: Math.min(
        this.config.maxOutputTokens,
        Math.max(64, options.maxOutputTokens ?? this.config.maxOutputTokens),
      ),
    };
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
        const response = await this.fetchImpl(`${this.config.baseUrl}/chat/completions`, {
          method: "POST",
          headers: this.headers(),
          signal: controller.signal,
          body: JSON.stringify(
            this.requestBody(
              [
                { role: "system", content: system },
                { role: "user", content: user },
              ],
              options,
            ),
          ),
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

function normalizeError(error: unknown, timeoutMs: number, signal?: AbortSignal): Error {
  if (signal?.aborted) return abortError();
  if (error instanceof LlmResponseError) return error;
  if (error instanceof Error && error.name === "AbortError") {
    return new LlmResponseError(`LLM 请求超过 ${timeoutMs}ms`, null);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function abortError(): Error {
  const error = new Error("请求已取消");
  error.name = "AbortError";
  return error;
}

function parseJsonObject(text: string, status: number): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new LlmResponseError("LLM 返回的响应不是 JSON", status);
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new LlmResponseError("LLM 返回的响应不是 JSON 对象", status);
  }
  return parsed as Record<string, unknown>;
}

/** 超过 timeoutMs 没有收到任何数据就中止；流式响应只要还在吐字就不算超时。 */
class IdleTimer {
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly timeoutMs: number,
    private readonly onIdle: () => void,
  ) {
    this.touch();
  }

  touch(): void {
    this.stop();
    this.timer = setTimeout(this.onIdle, this.timeoutMs);
  }

  stop(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

async function readEventStream(
  body: ReadableStream<Uint8Array>,
  onDelta: (text: string) => void,
  idle: IdleTimer,
): Promise<StreamResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let content = "";
  let usage: LlmUsage = { ...emptyUsage(), requests: 1 };

  const handle = (line: string): boolean => {
    if (!line.startsWith("data:")) return false;
    const data = line.slice(5).trim();
    if (data === "[DONE]") return true;
    let chunk: unknown;
    try {
      chunk = JSON.parse(data);
    } catch {
      return false;
    }
    if (typeof chunk !== "object" || chunk === null) return false;
    const record = chunk as Record<string, unknown>;
    if (record["error"] !== undefined) {
      throw new LlmResponseError(safeApiError(JSON.stringify(record)) ?? "LLM 流式响应报错", 200);
    }
    const delta = deltaText(record);
    if (delta !== "") {
      content += delta;
      onDelta(delta);
    }
    if (typeof record["usage"] === "object" && record["usage"] !== null) usage = responseUsage(record);
    return false;
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      idle.touch();
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (handle(line)) return { content, usage };
      }
    }
    buffer += decoder.decode();
    if (buffer.trim() !== "") handle(buffer.trim());
    return { content, usage };
  } finally {
    reader.releaseLock();
  }
}

function deltaText(chunk: Record<string, unknown>): string {
  const choices = chunk["choices"];
  if (!Array.isArray(choices) || choices.length === 0) return "";
  const choice = choices[0] as Record<string, unknown> | null;
  const delta = typeof choice === "object" && choice !== null ? choice["delta"] : null;
  const content = typeof delta === "object" && delta !== null ? (delta as Record<string, unknown>)["content"] : null;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        typeof part === "object" && part !== null && typeof part["text"] === "string" ? part["text"] : "",
      )
      .join("");
  }
  return "";
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

/**
 * 按当前配置判断 AI 能不能用，不能用时返回原因。
 *
 * 只看开关和凭据，不发请求：概览接口每次打开页面都会调用，探测网络
 * 既慢又可能产生费用。
 */
export function llmUnavailableReason(config: LlmConfig, explicitKey?: string): string | null {
  if (!config.enabled) return "LLM 已在配置中关闭";
  const apiKey = explicitKey ?? envApiKey(config);
  if (apiKey === undefined || (apiKey === "" && config.apiKeyEnv.trim() !== "")) {
    return `未设置环境变量 ${config.apiKeyEnv}`;
  }
  return null;
}

function envApiKey(config: LlmConfig): string | undefined {
  return config.apiKeyEnv.trim() === "" ? "" : process.env[config.apiKeyEnv]?.trim();
}

export function emptyUsage(): LlmUsage {
  return { requests: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
}

export function addUsage(target: LlmUsage, value: LlmUsage): void {
  target.requests += value.requests;
  target.inputTokens += value.inputTokens;
  target.outputTokens += value.outputTokens;
  target.totalTokens += value.totalTokens;
}
