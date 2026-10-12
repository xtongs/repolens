import { CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, LOCK_FILENAME, loadConfig } from "./config.js";
import { buildIgnoreMatcher, HARD_IGNORED_DIRS } from "./discovery/ignore.js";

const CONVENTION_FILES = new Set([CONFIG_FILENAME, LOCAL_CONFIG_FILENAME, LOCK_FILENAME]);

/**
 * 盯着文件变化时，哪些改动值得刷新一次索引。忽略规则和扫描一致；根目录下的团队约定、
 * 个人配置和依赖锁就算被 .gitignore 掉也算，体检结论由它们决定。
 * `file` 是 fs.watch 报上来的相对路径，平台没给出路径时按「可能有关」处理。
 */
export function indexChangeFilter(root: string): (file: string | null) => boolean {
  const config = loadConfig(root);
  const ignore = buildIgnoreMatcher(root, config.exclude, config.include);
  return (file) => {
    if (!file) return true;
    const parts = file.split(/[\\/]+/).filter(Boolean);
    if (parts.length === 0) return false;
    if (parts.length === 1 && CONVENTION_FILES.has(parts[0]!)) return true;
    if (parts.some((part) => HARD_IGNORED_DIRS.has(part))) return false;
    return !ignore.ignores(parts.join("/"));
  };
}
