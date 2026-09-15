import type { DiscoveredPackage, ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { joinPosix } from "./path-utils.js";

/**
 * Go 模块解析器。
 *
 * 和其他语言最大的不同：Go 的 import 是**包级**的，说明符对应一个目录而不是文件，
 * 所以内部命中返回 `internal-dir`。目录里哪个文件定义了被引用的符号，要等 link
 * 阶段拿着符号表去该目录下所有文件里找。
 */
export function createGoResolver(): ModuleResolver {
  return {
    languages: ["go"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      const path = specifier.trim();
      if (path.length === 0) {
        return { status: "unresolved", reason: "空说明符" };
      }

      // Go 不支持相对 import（GOPATH 时代的遗留写法在 module 模式下非法）
      if (path.startsWith(".") || path.startsWith("/")) {
        return { status: "unresolved", reason: `Go module 模式不支持相对/绝对路径 import：${path}` };
      }

      const owner = matchModule(path, ctx.packages);
      if (owner) {
        const subpath = path.slice(owner.name.length).replace(/^\//, "");
        const dir = joinPosix(owner.dir, subpath);
        if (ctx.hasDir(dir)) return { status: "internal-dir", target: dir };
        return {
          status: "unresolved",
          reason: `属于本仓库 module ${owner.name}，但包目录 ${dir} 不存在`,
        };
      }

      const first = path.split("/")[0] ?? path;
      // 标准库的第一段永远不含点号，第三方则必须是域名形式，这是 Go 官方的区分规则
      if (!first.includes(".")) {
        return { status: "external", name: path };
      }

      return { status: "external", name: moduleNameOf(path) };
    },
  };
}

/** 同前缀时取 module 名最长的，避免 `example.com/a` 抢走 `example.com/a/b` 的解析 */
function matchModule(
  path: string,
  packages: readonly DiscoveredPackage[],
): DiscoveredPackage | null {
  let best: DiscoveredPackage | null = null;
  for (const pkg of packages) {
    if (pkg.manager !== "go") continue;
    if (path !== pkg.name && !path.startsWith(`${pkg.name}/`)) continue;
    if (!best || pkg.name.length > best.name.length) best = pkg;
  }
  return best;
}

/** `github.com/x/y/pkg/sub` → `github.com/x/y`：前三段就是依赖的仓库标识 */
function moduleNameOf(path: string): string {
  const segments = path.split("/");
  return segments.slice(0, 3).join("/");
}
