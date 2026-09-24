import { timingSafeEqual } from "node:crypto";

/**
 * 访问令牌的传递方式。单独成文件是为了让桌面端主进程只引用这几个常量，
 * 不必把整个服务端连同 SQLite 原生模块一起加载进主进程。
 */
export const ACCESS_TOKEN_COOKIE = "repolens_token";
export const ACCESS_TOKEN_HEADER = "x-repolens-token";

export function sameToken(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
