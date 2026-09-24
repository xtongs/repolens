const IS_MAC = typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/**
 * 快捷键的显示文字：macOS 写 ⌘K，其他平台写 Ctrl+K。
 * 按键处理本身 ⌘ 和 Ctrl 都认，这里只决定标签怎么写。
 */
export function modKey(key: string): string {
  return IS_MAC ? `⌘${key}` : `Ctrl+${key}`;
}

/** Option / Alt 键的显示文字 */
export const ALT_KEY = IS_MAC ? "⌥" : "Alt+";
