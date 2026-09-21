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
  "bower_components",
  "jspm_packages",
  "web_modules",
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
  const rootGit = readIgnoreFile(join(repoRoot, ".gitignore"));
  const repolens = readIgnoreFile(join(repoRoot, ".repolensignore"));
  const configured = ignoreFactory();
  if (exclude.length > 0) configured.add(exclude);
  // ignore 包用 `!pattern` 表达反向豁免，放在最后使其覆盖前面的规则。
  if (include.length > 0) configured.add(include.map((p) => (p.startsWith("!") ? p : `!${p}`)));

  // 每个子目录可以有自己的 .gitignore。按需读取并缓存，既符合 Git 的
  // “规则相对所在目录”语义，也不需要预先遍历一遍整个仓库。
  const nested = new Map<string, ReturnType<typeof ignoreFactory> | null>();
  const nestedIgnore = (scope: string) => {
    if (nested.has(scope)) return nested.get(scope) ?? null;
    const loaded = readIgnoreFile(join(repoRoot, ...scope.split("/"), ".gitignore"));
    nested.set(scope, loaded);
    return loaded;
  };

  return {
    ignores(repoRelPath: string): boolean {
      if (repoRelPath === "" || repoRelPath === ".") return false;
      try {
        let ignored = applyIgnore(false, rootGit, repoRelPath);
        const clean = repoRelPath.endsWith("/") ? repoRelPath.slice(0, -1) : repoRelPath;
        const parts = clean.split("/");
        // 检查路径所有父目录里的 .gitignore；目录自己的规则只管其内部，
        // 不能决定这个目录本身是否被父级遍历。
        for (let depth = 1; depth < parts.length; depth++) {
          const scope = parts.slice(0, depth).join("/");
          const localPath = repoRelPath.slice(scope.length + 1);
          ignored = applyIgnore(ignored, nestedIgnore(scope), localPath);
        }
        // RepoLens 专用规则和显式配置拥有最高优先级。
        ignored = applyIgnore(ignored, repolens, repoRelPath);
        return applyIgnore(ignored, configured, repoRelPath);
      } catch {
        return false;
      }
    },
  };
}

function readIgnoreFile(path: string): ReturnType<typeof ignoreFactory> | null {
  if (!existsSync(path)) return null;
  return ignoreFactory().add(readFileSync(path, "utf8"));
}

function applyIgnore(
  current: boolean,
  matcher: ReturnType<typeof ignoreFactory> | null,
  path: string,
): boolean {
  if (matcher === null || path === "") return current;
  const result = matcher.test(path);
  if (result.ignored) return true;
  if (result.unignored) return false;
  return current;
}
