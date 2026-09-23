import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DiscoveredPackage, ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { dirOf, joinPosix, normalizePosix } from "./path-utils.js";

const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".vue",
  ".svelte",
  ".astro",
  ".d.ts",
] as const;

/**
 * TypeScript / JavaScript 模块解析器。
 *
 * 覆盖四种说明符形式，按成本从低到高依次尝试：
 * 1. 相对路径 `./x` `../x`
 * 2. tsconfig 的 `paths` 别名
 * 3. workspace 包名
 * 4. 其余视为第三方
 *
 * 最容易被忽略的一点是 NodeNext 下的 `.js` 扩展名约定：源码里写 `./foo.js`，
 * 磁盘上其实是 `foo.ts`。不处理这条，现代 TS 仓库的解析率会直接掉到个位数。
 */
export function createTsResolver(): ModuleResolver {
  const tsconfigCache = new Map<string, TsPathMapping | null>();

  return {
    languages: ["typescript", "tsx", "javascript", "jsx", "vue", "svelte", "astro"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      if (specifier.length === 0) {
        return { status: "unresolved", reason: "空说明符" };
      }

      // 非源码资源的 import（CSS / 图片 / wasm）不属于代码依赖
      if (/\.(css|scss|sass|less|svg|png|jpe?g|gif|webp|woff2?|ttf|wasm|json|txt|md)$/i.test(specifier)) {
        if (specifier.startsWith(".")) {
          const target = tryFile(joinPosix(dirOf(ctx.fromFile), specifier), ctx);
          if (target) return { status: "internal", target };
        }
        return { status: "external", name: specifier };
      }

      if (specifier.startsWith("./") || specifier.startsWith("../")) {
        const base = joinPosix(dirOf(ctx.fromFile), specifier);
        const target = tryFile(base, ctx);
        return target
          ? { status: "internal", target }
          : { status: "unresolved", reason: `相对路径无匹配文件：${base}` };
      }

      if (specifier.startsWith("/")) {
        return { status: "unresolved", reason: "绝对路径 import 无法在仓库内定位" };
      }

      if (specifier.startsWith("node:")) {
        return { status: "external", name: specifier };
      }

      const mapping = pathMappingFor(ctx, ctx.fromFile, tsconfigCache);
      if (mapping) {
        const viaPaths = resolveViaPaths(specifier, mapping, ctx);
        if (viaPaths) return { status: "internal", target: viaPaths };
      }

      const viaWorkspace = resolveWorkspacePackage(specifier, ctx);
      if (viaWorkspace) return viaWorkspace;

      return { status: "external", name: packageNameOf(specifier) };
    },
  };
}

// ---------------------------------------------------------------------------
// 文件候选
// ---------------------------------------------------------------------------

function tryFile(base: string, ctx: ResolveContext): string | null {
  for (const candidate of candidatePaths(base)) {
    if (ctx.hasFile(candidate)) return candidate;
  }
  return null;
}

function candidatePaths(base: string): string[] {
  const out: string[] = [base];

  // `./foo.js` → `./foo.ts`：TS 的 NodeNext 约定
  const jsExt = /\.(js|mjs|cjs|jsx)$/.exec(base);
  if (jsExt) {
    const stem = base.slice(0, -jsExt[0].length);
    out.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`, `${stem}.d.ts`);
  }

  const hasKnownExt = SOURCE_EXTENSIONS.some((ext) => base.endsWith(ext));
  if (!hasKnownExt) {
    for (const ext of SOURCE_EXTENSIONS) out.push(base + ext);
  }

  for (const ext of SOURCE_EXTENSIONS) out.push(`${base}/index${ext}`);

  return out;
}

// ---------------------------------------------------------------------------
// tsconfig paths
// ---------------------------------------------------------------------------

interface TsPathMapping {
  /** 相对仓库根的 baseUrl 目录 */
  baseDir: string;
  paths: Array<{ prefix: string; suffix: string; targets: string[] }>;
}

function pathMappingFor(
  ctx: ResolveContext,
  fromFile: string,
  cache: Map<string, TsPathMapping | null>,
): TsPathMapping | null {
  // 从文件所在目录向上找最近的 tsconfig，与 tsc 的行为一致
  let dir = dirOf(fromFile);
  for (;;) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      if (cached !== null) return cached;
    } else {
      const configPath = dir === "." ? "tsconfig.json" : `${dir}/tsconfig.json`;
      const loaded = ctx.hasFile(configPath) ? loadTsPathMapping(ctx.root, configPath) : null;
      cache.set(dir, loaded);
      if (loaded !== null) return loaded;
    }
    if (dir === ".") return null;
    dir = dirOf(dir);
  }
}

function loadTsPathMapping(root: string, configRelPath: string, depth = 0): TsPathMapping | null {
  if (depth > 5) return null;

  const json = readJsonc(join(root, configRelPath));
  if (!json) return null;

  const options = (json["compilerOptions"] ?? {}) as Record<string, unknown>;
  const configDir = dirOf(configRelPath);
  const baseUrl = typeof options["baseUrl"] === "string" ? options["baseUrl"] : null;
  const rawPaths = options["paths"];

  if (rawPaths && typeof rawPaths === "object") {
    const baseDir = normalizePosix(joinPosix(configDir, baseUrl ?? "."));
    const paths: TsPathMapping["paths"] = [];
    for (const [pattern, targets] of Object.entries(rawPaths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const star = pattern.indexOf("*");
      paths.push({
        prefix: star >= 0 ? pattern.slice(0, star) : pattern,
        suffix: star >= 0 ? pattern.slice(star + 1) : "",
        targets: targets.filter((t): t is string => typeof t === "string"),
      });
    }
    if (paths.length > 0) return { baseDir, paths };
  }

  // 本层没有 paths 就沿 extends 链继续找
  const extendsField = json["extends"];
  if (typeof extendsField === "string" && extendsField.startsWith(".")) {
    const parentRel = normalizePosix(joinPosix(configDir, extendsField));
    const withExt = parentRel.endsWith(".json") ? parentRel : `${parentRel}.json`;
    return loadTsPathMapping(root, withExt, depth + 1);
  }

  return null;
}

function resolveViaPaths(
  specifier: string,
  mapping: TsPathMapping,
  ctx: ResolveContext,
): string | null {
  for (const entry of mapping.paths) {
    if (!specifier.startsWith(entry.prefix)) continue;
    if (entry.suffix.length > 0 && !specifier.endsWith(entry.suffix)) continue;

    const wildcard = specifier.slice(
      entry.prefix.length,
      entry.suffix.length > 0 ? specifier.length - entry.suffix.length : undefined,
    );

    for (const target of entry.targets) {
      const substituted = target.includes("*") ? target.replace("*", wildcard) : target;
      const base = normalizePosix(joinPosix(mapping.baseDir, substituted));
      const hit = tryFile(base, ctx);
      if (hit) return hit;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// workspace 包
// ---------------------------------------------------------------------------

function resolveWorkspacePackage(specifier: string, ctx: ResolveContext): ResolveOutcome | null {
  const pkg = matchPackage(specifier, ctx.packages);
  if (!pkg) return null;

  const subpath = specifier.slice(pkg.name.length).replace(/^\//, "");

  if (subpath.length === 0) {
    // 包根：优先按声明的入口找，再退到约定位置
    for (const entry of pkg.entryPoints) {
      const hit = tryFile(normalizePosix(joinPosix(pkg.dir, entry)), ctx);
      if (hit) return { status: "internal", target: hit };
    }
    for (const fallback of ["src/index", "index", "src/main", "lib/index"]) {
      const hit = tryFile(normalizePosix(joinPosix(pkg.dir, fallback)), ctx);
      if (hit) return { status: "internal", target: hit };
    }
    return { status: "unresolved", reason: `workspace 包 ${pkg.name} 未找到入口文件` };
  }

  // 子路径导出：`@scope/pkg/types` 可能对应 src/types.ts 也可能对应 types.ts
  for (const prefix of ["src", "", "lib", "dist"]) {
    const base = normalizePosix(joinPosix(pkg.dir, joinPosix(prefix, subpath)));
    const hit = tryFile(base, ctx);
    if (hit) return { status: "internal", target: hit };
  }

  // exports 映射可能把子路径指到任意位置，用入口列表里同名的那个兜底
  const entryHit = pkg.entryPoints.find((e) => e.includes(subpath));
  if (entryHit) {
    const hit = tryFile(normalizePosix(joinPosix(pkg.dir, entryHit)), ctx);
    if (hit) return { status: "internal", target: hit };
  }

  return { status: "unresolved", reason: `workspace 包 ${pkg.name} 的子路径 ${subpath} 未命中` };
}

function matchPackage(
  specifier: string,
  packages: readonly DiscoveredPackage[],
): DiscoveredPackage | null {
  let best: DiscoveredPackage | null = null;
  for (const pkg of packages) {
    if (pkg.manager === "go" || pkg.manager === "cargo" || pkg.manager === "python") continue;
    if (specifier !== pkg.name && !specifier.startsWith(`${pkg.name}/`)) continue;
    // 同前缀时取名字最长的，避免 `@a/b` 抢走 `@a/b-c` 的解析
    if (!best || pkg.name.length > best.name.length) best = pkg;
  }
  return best;
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split("/");
  if (specifier.startsWith("@") && parts.length >= 2) return `${parts[0]}/${parts[1]}`;
  return parts[0] ?? specifier;
}

// ---------------------------------------------------------------------------
// JSONC
// ---------------------------------------------------------------------------

/**
 * tsconfig.json 几乎总是带注释和尾逗号，标准 JSON.parse 直接报错。
 * 这里做最小容错处理，不引入完整的 JSONC 解析器。
 */
function readJsonc(absPath: string): Record<string, unknown> | null {
  let text: string;
  try {
    text = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  if (!existsSync(absPath)) return null;

  const stripped = stripJsonComments(text).replace(/,(\s*[}\]])/g, "$1");
  try {
    const parsed = JSON.parse(stripped);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function stripJsonComments(text: string): string {
  let out = "";
  let inString = false;
  let inLine = false;
  let inBlock = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    const next = text[i + 1];

    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i++;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}
