import type { DiscoveredPackage, ModuleResolver, ResolveContext, ResolveOutcome } from "../types.js";
import { dirOf, isWithin, joinPosix, stripExtension } from "./path-utils.js";

/** 语言自带 crate，永远不在仓库里 */
const BUILTIN_CRATES: ReadonlySet<string> = new Set(["std", "core", "alloc", "proc_macro", "test"]);

/** 文件名为这些时，该文件代表所在目录（或 crate 根）那一层模块，而不是同名子模块 */
const MODULE_ROOT_STEMS: ReadonlySet<string> = new Set(["mod", "lib", "main"]);

/**
 * Rust 模块解析器。
 *
 * 核心难点：说明符的最后一段可能是模块名，也可能是符号名——`crate::a::b` 的 `b`
 * 既可能是 `a/b.rs`，也可能是 `a.rs` 里的一个 struct。ModuleResolver 的契约只给
 * 说明符，拿不到 specifier 列表，所以这里对路径前缀逐级回退，命中的第一个真实文件
 * 就是答案。回退只到剩一段为止，不会一路退到 `lib.rs`，否则任何拼错的路径都会被
 * 错误地解析成 crate 根。
 *
 * 只有在「符号除了那个文件无处可去」时才用 fallback：`super::Foo` 必然定义在父模块
 * 自己的文件里，`crate::Foo` 必然在 crate 根里。这不是猜，是推出来的唯一可能。
 */
export function createRustResolver(): ModuleResolver {
  return {
    languages: ["rust"],

    resolve(specifier: string, ctx: ResolveContext): ResolveOutcome {
      const segments = splitPath(specifier);
      const head = segments[0];
      if (head === undefined) {
        return { status: "unresolved", reason: "空说明符" };
      }

      const srcDir = crateRootOf(ctx);
      const ownModule = moduleSegments(ctx.fromFile, srcDir);

      if (head === "crate" || head === "$crate") {
        const tail = segments.slice(1);
        return resolveWithin(tail, srcDir, ctx, specifier, tail.length <= 1 ? [] : undefined);
      }

      if (head === "self") {
        const tail = segments.slice(1);
        // 长度为 1 时是 `mod foo;` 的形状，目标应该是 foo.rs 而不是当前文件，
        // 找不到就该报出来；长度 >= 2 说明中间那段是内联 mod，只能在当前文件里
        const fallback = tail.length === 1 ? undefined : ownModule;
        return resolveWithin([...ownModule, ...tail], srcDir, ctx, specifier, fallback);
      }

      if (head === "super") {
        let depth = 0;
        while (segments[depth] === "super") depth++;
        if (depth > ownModule.length) {
          return { status: "unresolved", reason: `${specifier} 的 super 层数超出当前模块深度` };
        }
        const base = ownModule.slice(0, ownModule.length - depth);
        const tail = segments.slice(depth);
        return resolveWithin([...base, ...tail], srcDir, ctx, specifier, tail.length <= 1 ? base : undefined);
      }

      const crate = matchCrate(head, ctx.packages);
      if (crate) {
        // 跨 crate 引用退到对方的 lib.rs 是合理答案：那是它唯一的公开入口
        return resolveWithin(segments.slice(1), crateRootFor(crate), ctx, specifier, []);
      }

      if (BUILTIN_CRATES.has(head)) {
        return { status: "external", name: head };
      }

      // Rust 2018 的 uniform path：crate 根下的顶层模块可以省掉 `crate::` 前缀。
      // 这里不给 fallback，只认精确命中，否则第三方 crate 会被误判成内部模块。
      const uniform = findModuleFile(segments, srcDir, ctx);
      if (uniform) return { status: "internal", target: uniform };

      return { status: "external", name: head };
    },
  };
}

// ---------------------------------------------------------------------------
// 模块路径 → 文件
// ---------------------------------------------------------------------------

function resolveWithin(
  segments: readonly string[],
  srcDir: string,
  ctx: ResolveContext,
  specifier: string,
  fallbackModule: readonly string[] | undefined,
): ResolveOutcome {
  const direct = findModuleFile(segments, srcDir, ctx);
  if (direct) return { status: "internal", target: direct };

  if (fallbackModule) {
    const hit = moduleFile(fallbackModule, srcDir, ctx);
    if (hit) return { status: "internal", target: hit };
  }

  return { status: "unresolved", reason: `${specifier} 在 ${srcDir} 下没有对应的 .rs / mod.rs` };
}

/** 从最长前缀开始逐级回退，第一个存在的文件就是目标 */
function findModuleFile(
  segments: readonly string[],
  srcDir: string,
  ctx: ResolveContext,
): string | null {
  for (let length = segments.length; length >= 1; length--) {
    const hit = moduleFile(segments.slice(0, length), srcDir, ctx);
    if (hit) return hit;
  }
  return null;
}

/** 模块路径对应的落地文件：`a/b` → `a/b.rs` 或 `a/b/mod.rs`；空路径 → crate 根 */
function moduleFile(
  segments: readonly string[],
  srcDir: string,
  ctx: ResolveContext,
): string | null {
  if (segments.length === 0) {
    for (const stem of ["lib.rs", "main.rs"]) {
      const candidate = joinPosix(srcDir, stem);
      if (ctx.hasFile(candidate)) return candidate;
    }
    return null;
  }

  const prefix = segments.join("/");
  const asFile = joinPosix(srcDir, `${prefix}.rs`);
  if (ctx.hasFile(asFile)) return asFile;
  const asDirectory = joinPosix(srcDir, prefix, "mod.rs");
  if (ctx.hasFile(asDirectory)) return asDirectory;
  return null;
}

/**
 * 当前文件在自己 crate 里的模块路径。
 *
 * `src/lib.rs` → `[]`，`src/store/mod.rs` → `["store"]`，
 * `src/store/models.rs` → `["store","models"]`。
 */
function moduleSegments(file: string, srcDir: string): string[] {
  if (!isWithin(srcDir, file)) return [];
  const relative = srcDir === "." ? file : file.slice(srcDir.length + 1);
  const parts = stripExtension(relative)
    .split("/")
    .filter((p) => p.length > 0);
  if (MODULE_ROOT_STEMS.has(parts.at(-1) ?? "")) parts.pop();
  return parts;
}

function splitPath(specifier: string): string[] {
  return specifier
    .split("::")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---------------------------------------------------------------------------
// crate 定位
// ---------------------------------------------------------------------------

/** Cargo 自动发现 target 的目录，目录内每个 .rs 各自是一个 crate 根 */
const AUTO_TARGET_DIRS = ["tests", "benches", "examples", "src/bin"] as const;

/**
 * 当前文件所属 crate 的根目录。
 *
 * 不能直接认 `<包目录>/src`：Cargo 允许 `[lib]` / `[[bin]]` 用 `path` 把入口
 * 指到任意位置，那个位置的目录才是该 target 的 crate 根。所以从声明出来的
 * 入口反推候选根，取**包含当前文件的最长那个**——一个文件属于哪个 target，
 * 就该按那个 target 的根来解析 `crate::`。
 *
 * 没有 Cargo.toml 时退回路径里第一个 `src` 段。
 */
function crateRootOf(ctx: ResolveContext): string {
  let best: DiscoveredPackage | null = null;
  for (const pkg of ctx.packages) {
    if (pkg.manager !== "cargo") continue;
    if (!isWithin(pkg.dir, ctx.fromFile)) continue;
    if (!best || pkg.dir.length > best.dir.length) best = pkg;
  }

  if (best) {
    let root: string | null = null;

    // Cargo 自动发现的 target 目录：这几个目录下每个 .rs 文件各自是一个 crate 根，
    // 所以目录本身就是解析 `crate::` 的起点。这是固定约定不是猜测，
    // 而 ripgrep 的 tests/tests.rs 靠 `mod util;` 引 tests/util.rs 正是这种形状。
    for (const convention of AUTO_TARGET_DIRS) {
      const dir = joinPosix(best.dir, convention);
      if (isWithin(dir, ctx.fromFile) && (root === null || dir.length > root.length)) root = dir;
    }

    for (const entry of best.entryPoints ?? []) {
      const dir = dirOf(joinPosix(best.dir, entry));
      if (!isWithin(dir, ctx.fromFile)) continue;
      if (root === null || dir.length > root.length) root = dir;
    }
    return root ?? joinPosix(best.dir, "src");
  }

  const parts = ctx.fromFile.split("/");
  const index = parts.indexOf("src");
  if (index >= 0) return parts.slice(0, index + 1).join("/");
  return dirOf(ctx.fromFile);
}

/** 跨 crate 引用时对方的根目录；对方的文件不在手上，只能按入口声明取 */
function crateRootFor(pkg: DiscoveredPackage): string {
  const entry = (pkg.entryPoints ?? []).find((p) => p.endsWith("lib.rs")) ?? pkg.entryPoints?.[0];
  return entry !== undefined ? dirOf(joinPosix(pkg.dir, entry)) : joinPosix(pkg.dir, "src");
}

/** Cargo 包名用 `-`，Rust 路径里用 `_`，必须归一化后再比 */
function matchCrate(head: string, packages: readonly DiscoveredPackage[]): DiscoveredPackage | null {
  for (const pkg of packages) {
    if (pkg.manager !== "cargo") continue;
    if (pkg.name.replace(/-/g, "_") === head) return pkg;
  }
  return null;
}
