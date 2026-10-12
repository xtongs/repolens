import type { MessageParams, Translation } from "./index";

/** 数字可能已经带了千分位，按去掉逗号后的值判断单复数 */
export function count(params: MessageParams, key = "count"): string {
  return String(params[key] ?? "");
}

export function plural(params: MessageParams, one: string, many: string, key = "count"): string {
  return Number(count(params, key).replace(/,/g, "")) === 1 ? one : many;
}

/** `{count} 个文件` 这类只差一个名词单复数的词条 */
export function counted(one: string, many: string, key = "count"): Translation {
  return (params) => `${count(params, key)} ${plural(params, one, many, key)}`;
}
