import ignoreFactory from "ignore";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 无论 `.gitignore` 怎么写都不该进入索引的目录。
 * 单独列出来是因为很多仓库并不把这些写进 `.gitignore`（比如 monorepo 的嵌套 node_modules）。
 */
export const HARD_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  ".repolens",
  ".venv",
  "venv",
  "__pycache__",
  ".mypy_cache",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode-test",
  ".turbo",
  ".nx",
  ".cache",
  ".parcel-cache",
  ".pnpm-store",
  "target", // Rust 构建产物；Cargo 项目里从不含源码
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".output",
  "coverage",
]);

export interface IgnoreMatcher {
  /** 路径为仓库相对 posix 路径；目录需以 `/` 结尾以匹配目录规则 */
  ignores: (repoRelPath: string) => boolean;
}

/**
 * 组合仓库根的 `.gitignore`、`.repolensignore` 与用户配置的 exclude/include。
 *
 * 只读根级 ignore 文件，不递归收集子目录的 `.gitignore`：后者需要按目录分层匹配，
 * 复杂度不小，而实际收益有限——绝大多数被忽略的路径都被 HARD_IGNORED_DIRS 拦住了。
 */
export function buildIgnoreMatcher(
  repoRoot: string,
  exclude: string[],
  include: string[],
): IgnoreMatcher {
  const ig = ignoreFactory();

  for (const file of [".gitignore", ".repolensignore"]) {
    const path = join(repoRoot, file);
    if (existsSync(path)) {
      ig.add(readFileSync(path, "utf8"));
    }
  }
  if (exclude.length > 0) ig.add(exclude);
  // ignore 包用 `!pattern` 表达反向豁免，放在最后使其覆盖前面的规则。
  if (include.length > 0) ig.add(include.map((p) => (p.startsWith("!") ? p : `!${p}`)));

  return {
    ignores(repoRelPath: string): boolean {
      if (repoRelPath === "" || repoRelPath === ".") return false;
      try {
        return ig.ignores(repoRelPath);
      } catch {
        return false;
      }
    },
  };
}
