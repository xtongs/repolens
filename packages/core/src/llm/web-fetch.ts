import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { BlockList, isIP } from "node:net";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const MAX_REDIRECTS = 5;
/** 解压后的字节数上限，压缩炸弹也只能读到这里 */
const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 15_000;
const USER_AGENT = "Mozilla/5.0 (compatible; RepoLens; +https://github.com/xtongs/repolens)";
const TEXTUAL = /^text\/|json|xml|javascript|ecmascript|yaml|toml|markdown/i;

export class WebFetchError extends Error {}

export interface WebPage {
  /** 跟随重定向之后的地址 */
  url: string;
  title: string | null;
  text: string;
  /** 页面超过读取上限，只读了开头 */
  truncated: boolean;
}

export interface FetchPageOptions {
  signal?: AbortSignal | undefined;
  /** 判定一个 IP 能不能连；测试用它把本机地址当成外网 */
  isBlockedAddress?: (address: string) => boolean;
}

/**
 * 本机、内网、链路本地、组播和保留地址。抓网页的请求由模型发起，而模型读过的
 * 文件和网页里可能藏着指令，不能让它借这个能力去探内网服务或本机端口。
 */
const PRIVATE_NETWORKS = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16],
  ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96], ["2002::", 16],
] as const) PRIVATE_NETWORKS.addSubnet(network, prefix, "ipv6");

export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 0) return true;
  return PRIVATE_NETWORKS.check(address, family === 6 ? "ipv6" : "ipv4");
}

/**
 * 抓一个公开网页，返回可读的纯文本。
 *
 * 地址校验放在建立连接时的 DNS 解析里做，而不是先查一遍再请求：两次解析之间
 * 域名可以换成内网地址（DNS 重绑定）。重定向的每一跳都重新校验。
 */
export async function fetchWebPage(raw: string, options: FetchPageOptions = {}): Promise<WebPage> {
  const blocked = options.isBlockedAddress ?? isPrivateAddress;
  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  let url = parseUrl(raw);
  try {
    for (let hop = 0; ; hop++) {
      const response = await get(url, signal, blocked);
      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (hop >= MAX_REDIRECTS) throw new WebFetchError("网页重定向次数过多");
        url = parseUrl(new URL(location, url).toString());
        continue;
      }
      return await readPage(url, response);
    }
  } catch (err) {
    if (options.signal?.aborted) throw err;
    if (deadline.aborted) throw new WebFetchError(`网页超过 ${TIMEOUT_MS / 1000} 秒没有返回`);
    if (err instanceof WebFetchError) throw err;
    throw new WebFetchError(`网页抓取失败：${(err as Error).message}`);
  }
}

function parseUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new WebFetchError("不是合法的网址");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new WebFetchError("只能抓取 http 或 https 网址");
  if (url.username !== "" || url.password !== "") throw new WebFetchError("网址里不能带账号密码");
  return url;
}

function get(url: URL, signal: AbortSignal, blocked: (address: string) => boolean): Promise<IncomingMessage> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  // IP 直连不经过 lookup，要在这里先拦
  if (isIP(host) !== 0 && blocked(host)) return Promise.reject(new WebFetchError("不能访问本机或内网地址"));

  const lookup = (hostname: string, options: { all?: boolean }, callback: (...args: unknown[]) => void) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err);
      // 只要有一条记录指向内网就整体拒绝，不赌连接时会挑中哪一条
      if (addresses.length === 0 || addresses.some((item) => blocked(item.address))) {
        return callback(new WebFetchError("不能访问本机或内网地址"));
      }
      if (options.all) return callback(null, addresses);
      callback(null, addresses[0]!.address, addresses[0]!.family);
    });
  };

  return new Promise((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const request = send(url, {
      method: "GET",
      headers: {
        "user-agent": USER_AGENT,
        accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5",
        "accept-encoding": "gzip, deflate, br",
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
      lookup: lookup as never,
      signal,
    }, resolve);
    request.on("error", (err) => reject(err instanceof WebFetchError || !(err.cause instanceof WebFetchError) ? err : err.cause));
    request.end();
  });
}

async function readPage(url: URL, response: IncomingMessage): Promise<WebPage> {
  const status = response.statusCode ?? 0;
  const contentType = String(response.headers["content-type"] ?? "");
  if (status >= 400) {
    response.resume();
    throw new WebFetchError(`网页返回 HTTP ${status}`);
  }
  if (contentType !== "" && !TEXTUAL.test(contentType)) {
    response.resume();
    throw new WebFetchError(`不是文本网页（${contentType.split(";")[0]}）`);
  }

  const body = decompressed(response);
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body as AsyncIterable<Buffer>) {
    const room = MAX_BYTES - size;
    chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
    size += Math.min(chunk.length, room);
    if (size >= MAX_BYTES) {
      truncated = true;
      break;
    }
  }
  response.destroy();

  const bytes = Buffer.concat(chunks);
  const text = decodeText(bytes, contentType);
  const html = /html/i.test(contentType) || (contentType === "" && /^\s*<(?:!doctype html|html)/i.test(text));
  if (!html) return { url: url.toString(), title: null, text: text.trim(), truncated };
  const page = htmlToText(text, url);
  return { url: url.toString(), title: page.title, text: page.text, truncated };
}

function decompressed(response: IncomingMessage): Readable {
  const encoding = String(response.headers["content-encoding"] ?? "").trim().toLowerCase();
  const stream = encoding === "gzip" || encoding === "x-gzip"
    ? createGunzip()
    : encoding === "deflate"
      ? createInflate()
      : encoding === "br"
        ? createBrotliDecompress()
        : null;
  if (stream === null) return response;
  response.on("error", (err) => stream.destroy(err));
  return response.pipe(stream);
}

function decodeText(bytes: Buffer, contentType: string): string {
  const head = bytes.subarray(0, 2048).toString("latin1");
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? /<meta[^>]+charset=["']?([\w-]+)/i.exec(head)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// ---------------------------------------------------------------------------
// HTML 转纯文本
// ---------------------------------------------------------------------------

// 不去掉 form：老式页面会把整个正文包在一个 form 里
const DROPPED_BLOCKS = /<(script|style|noscript|template|svg|iframe|canvas|nav|aside|footer|select|button)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const BLOCK_TAGS = /<\/?(?:p|div|section|article|main|header|table|thead|tbody|tfoot|tr|ul|ol|dl|dt|dd|blockquote|figure|figcaption|details|summary|hr)\b[^>]*>/gi;

/**
 * 把网页转成给模型读的纯文本：标题、列表、代码块和链接保留成 Markdown 的样子，
 * 导航、页脚、脚本这类和正文无关的部分去掉。有 main / article 时只取正文区域。
 */
export function htmlToText(html: string, base: URL): { title: string | null; text: string } {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const title = titleMatch ? collapse(decodeEntities(stripTags(titleMatch[1]!))) || null : null;

  let doc = html.replace(/<!--[\s\S]*?-->/g, "").replace(/<head\b[\s\S]*?<\/head>/i, "");
  doc = region(doc, "article") ?? region(doc, "main") ?? doc;
  doc = doc.replace(DROPPED_BLOCKS, "");

  const blocks: string[] = [];
  const keep = (text: string) => `\u0000${blocks.push(text) - 1}\u0000`;
  doc = doc.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, inner: string) =>
    keep(`\n\n\`\`\`\n${decodeEntities(stripTags(inner.replace(/<br\s*\/?>/gi, "\n"))).replace(/\n+$/, "")}\n\`\`\`\n\n`));
  doc = doc
    .replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level: string, inner: string) =>
      `\n\n${"#".repeat(Number(level))} ${collapse(stripTags(inner))}\n\n`)
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href: string, inner: string) => {
      const text = collapse(stripTags(inner));
      const target = absoluteLink(decodeEntities(href), base);
      return text === "" ? "" : target === null || target === text ? text : `[${text}](${target})`;
    })
    .replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, inner: string) => `\`${collapse(stripTags(inner))}\``)
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]>/gi, " | ")
    .replace(BLOCK_TAGS, "\n");
  doc = decodeEntities(stripTags(doc));

  const text = doc
    .split("\n")
    .map((line) => line.replace(/[ \t\f\v\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\u0000(\d+)\u0000/g, (_, index: string) => blocks[Number(index)] ?? "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text };
}

/** 文档站常把正文放在 main / article 里；太短说明挑错了（比如只是一张卡片） */
function region(html: string, tag: string): string | null {
  const start = html.search(new RegExp(`<${tag}\\b`, "i"));
  const end = html.toLowerCase().lastIndexOf(`</${tag}>`);
  if (start < 0 || end <= start) return null;
  const inner = html.slice(start, end);
  return stripTags(inner).replace(/\s+/g, "").length >= 200 ? inner : null;
}

function absoluteLink(href: string, base: URL): string | null {
  if (href.startsWith("#") || /^(?:javascript|mailto|tel|data):/i.test(href)) return null;
  try {
    const url = new URL(href, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", mdash: "—", ndash: "–", hellip: "…",
  copy: "©", reg: "®", trade: "™", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”",
  middot: "·", bull: "•", times: "×", rarr: "→", larr: "←",
};

function decodeEntities(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, code: string) => {
    if (code[0] === "#") {
      const value = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(value) && value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : match;
    }
    return ENTITIES[code.toLowerCase()] ?? match;
  });
}
