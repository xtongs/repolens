import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { parse as parseToml } from "smol-toml";
import picomatch from "picomatch";
import type { DiscoveredPackage, PackageManager } from "../types.js";
import { HARD_IGNORED_DIRS } from "./ignore.js";

/**
 * 检测 monorepo 包边界。
 *
 * 为什么不用算法聚类：docs/INTERACTION.md 的「组织」策略要求分组必须是
 * 用户脑子里已有的结构。仓库自己声明的 workspace 边界就是最权威的答案，
 * 猜出来的社区划分再漂亮也不如它。
 */
export function discoverPackages(repoRoot: string): DiscoveredPackage[] {
  const found = new Map<string, DiscoveredPackage>();
  const add = (pkg: DiscoveredPackage) => {
    const existing = found.get(pkg.dir);
    // 同一目录被多种管理器命中时保留信息更全的那个
    if (!existing || existing.entryPoints.length < pkg.entryPoints.length) {
      found.set(pkg.dir, pkg);
    }
  };

  for (const pkg of detectNodeWorkspace(repoRoot)) add(pkg);
  for (const pkg of detectGoModules(repoRoot)) add(pkg);
  for (const pkg of detectCargo(repoRoot)) add(pkg);
  for (const pkg of detectPython(repoRoot)) add(pkg);

  return [...found.values()].sort((a, b) => a.dir.localeCompare(b.dir));
}

// ---------------------------------------------------------------------------
// Node: pnpm-workspace.yaml / package.json workspaces
// ---------------------------------------------------------------------------

function detectNodeWorkspace(repoRoot: string): DiscoveredPackage[] {
  const rootPkgPath = join(repoRoot, "package.json");
  if (!existsSync(rootPkgPath)) return [];

  const rootPkg = readJson(rootPkgPath);
  if (!rootPkg) return [];

  const manager = detectNodeManager(repoRoot);
  const globs = workspaceGlobs(repoRoot, rootPkg);

  // 没有 workspace 声明就是单包仓库
  if (globs.length === 0) {
    return [nodePackage(repoRoot, ".", rootPkg, manager)];
  }

  const out: DiscoveredPackage[] = [];
  const isRootPrivate = rootPkg["private"] === true;
  if (!isRootPrivate) out.push(nodePackage(repoRoot, ".", rootPkg, manager));

  for (const dir of expandGlobs(repoRoot, globs)) {
    const pkgJson = readJson(join(repoRoot, dir, "package.json"));
    if (pkgJson) out.push(nodePackage(repoRoot, dir, pkgJson, manager));
  }
  return out;
}

function detectNodeManager(repoRoot: string): PackageManager {
  if (existsSync(join(repoRoot, "pnpm-lock.yaml")) || existsSync(join(repoRoot, "pnpm-workspace.yaml"))) {
    return "pnpm";
  }
  if (existsSync(join(repoRoot, "yarn.lock"))) return "yarn";
  return "npm";
}

function workspaceGlobs(repoRoot: string, rootPkg: Record<string, unknown>): string[] {
  const pnpmPath = join(repoRoot, "pnpm-workspace.yaml");
  if (existsSync(pnpmPath)) {
    try {
      const doc = parseYaml(readFileSync(pnpmPath, "utf8")) as { packages?: unknown };
      if (Array.isArray(doc?.packages)) {
        return doc.packages.filter((p): p is string => typeof p === "string");
      }
    } catch {
      // 配置坏了不该让整次扫描失败，退化成单包
    }
  }

  const ws = rootPkg["workspaces"];
  if (Array.isArray(ws)) return ws.filter((p): p is string => typeof p === "string");
  if (ws && typeof ws === "object" && Array.isArray((ws as { packages?: unknown }).packages)) {
    return ((ws as { packages: unknown[] }).packages).filter((p): p is string => typeof p === "string");
  }
  return [];
}

function nodePackage(
  repoRoot: string,
  dir: string,
  pkgJson: Record<string, unknown>,
  manager: PackageManager,
): DiscoveredPackage {
  const name = typeof pkgJson["name"] === "string" ? pkgJson["name"] : dir === "." ? basename(repoRoot) : dir;
  return {
    name,
    dir,
    manager,
    version: typeof pkgJson["version"] === "string" ? pkgJson["version"] : undefined,
    entryPoints: nodeEntryPoints(pkgJson),
  };
}

/**
 * 从 package.json 收集入口候选。
 * 这些路径在 M4 会被当作「对外 API 入口」的起点，也用于解析 workspace 包名 import。
 */
export function nodeEntryPoints(pkgJson: Record<string, unknown>): string[] {
  const out = new Set<string>();
  const push = (v: unknown) => {
    if (typeof v === "string" && v.startsWith(".")) out.add(v.replace(/^\.\//, ""));
  };

  push(pkgJson["main"]);
  push(pkgJson["module"]);
  push(pkgJson["types"]);
  push(pkgJson["typings"]);

  const walkExports = (node: unknown): void => {
    if (typeof node === "string") return push(node);
    if (!node || typeof node !== "object") return;
    for (const value of Object.values(node as Record<string, unknown>)) walkExports(value);
  };
  walkExports(pkgJson["exports"]);

  const bin = pkgJson["bin"];
  if (typeof bin === "string") push(bin);
  else if (bin && typeof bin === "object") {
    for (const value of Object.values(bin as Record<string, unknown>)) push(value);
  }

  return [...out];
}

// ---------------------------------------------------------------------------
// Go
// ---------------------------------------------------------------------------

function detectGoModules(repoRoot: string): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const dir of findFilesNamed(repoRoot, "go.mod", 4)) {
    const content = readTextSafe(join(repoRoot, dir, "go.mod"));
    if (content === null) continue;
    const m = /^\s*module\s+(\S+)/m.exec(content);
    if (!m?.[1]) continue;
    out.push({
      name: m[1],
      dir,
      manager: "go",
      entryPoints: existsSync(join(repoRoot, dir, "main.go")) ? ["main.go"] : [],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Rust / Cargo
// ---------------------------------------------------------------------------

function detectCargo(repoRoot: string): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const dir of findFilesNamed(repoRoot, "Cargo.toml", 4)) {
    const content = readTextSafe(join(repoRoot, dir, "Cargo.toml"));
    if (content === null) continue;

    let doc: Record<string, unknown>;
    try {
      doc = parseToml(content) as Record<string, unknown>;
    } catch {
      continue;
    }

    const pkg = doc["package"] as { name?: unknown; version?: unknown } | undefined;
    if (typeof pkg?.name === "string") {
      out.push({
        name: pkg.name,
        dir,
        manager: "cargo",
        version: typeof pkg.version === "string" ? pkg.version : undefined,
        entryPoints: cargoEntryPoints(repoRoot, dir, doc),
      });
    }

    // workspace.members 里的成员在遍历中会被单独命中，这里只补齐纯 virtual manifest 的情况
    const ws = doc["workspace"] as { members?: unknown } | undefined;
    if (Array.isArray(ws?.members)) {
      const members = ws.members.filter((m): m is string => typeof m === "string");
      for (const memberDir of expandGlobs(repoRoot, members.map((m) => joinPosix(dir, m)))) {
        if (!existsSync(join(repoRoot, memberDir, "Cargo.toml"))) continue;
        const memberDoc = readTextSafe(join(repoRoot, memberDir, "Cargo.toml"));
        if (memberDoc === null) continue;
        try {
          const parsed = parseToml(memberDoc) as Record<string, unknown> & {
            package?: { name?: unknown };
          };
          if (typeof parsed.package?.name === "string") {
            out.push({
              name: parsed.package.name,
              dir: memberDir,
              manager: "cargo",
              entryPoints: cargoEntryPoints(repoRoot, memberDir, parsed as Record<string, unknown>),
            });
          }
        } catch {
          // 忽略坏掉的成员清单
        }
      }
    }
  }
  return out;
}

/**
 * crate 的入口文件。
 *
 * 约定布局是 `src/lib.rs` / `src/main.rs`，但 Cargo 允许 `[lib]` 和 `[[bin]]`
 * 用 `path` 指到任意位置，而那个位置的目录就是该 target 的 crate 根——
 * `crate::a::b` 要从它那里往下找，而不是从 `src/` 找。ripgrep 就是这样：
 * 根包声明 `[[bin]] path = "crates/core/main.rs"`，于是 `crate::flags::lowargs`
 * 落在 `crates/core/flags/lowargs.rs`。硬认 `src/` 会让这类仓库大批 import 解析失败。
 *
 * 只认显式声明，不猜 `src/bin/*.rs` 这类自动发现的 target：它们不在清单里，
 * 而每个都自成一个 crate 根，猜错反而会把模块解析引到别的 target 上去。
 */
function cargoEntryPoints(
  repoRoot: string,
  dir: string,
  doc: Record<string, unknown>,
): string[] {
  const declared: string[] = [];

  const lib = doc["lib"] as { path?: unknown } | undefined;
  if (typeof lib?.path === "string") declared.push(lib.path);

  const bins = doc["bin"];
  if (Array.isArray(bins)) {
    for (const bin of bins) {
      const path = (bin as { path?: unknown } | null)?.path;
      if (typeof path === "string") declared.push(path);
    }
  }

  const candidates = [...declared, "src/lib.rs", "src/main.rs"];
  const seen = new Set<string>();
  return candidates.filter((p) => {
    const normalized = toPosix(p);
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return existsSync(join(repoRoot, dir, normalized));
  });
}

// ---------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------

function detectPython(repoRoot: string): DiscoveredPackage[] {
  const out: DiscoveredPackage[] = [];
  for (const dir of findFilesNamed(repoRoot, "pyproject.toml", 4)) {
    const content = readTextSafe(join(repoRoot, dir, "pyproject.toml"));
    if (content === null) continue;
    let name: string | null = null;
    try {
      const doc = parseToml(content) as {
        project?: { name?: unknown };
        tool?: { poetry?: { name?: unknown } };
      };
      if (typeof doc.project?.name === "string") name = doc.project.name;
      else if (typeof doc.tool?.poetry?.name === "string") name = doc.tool.poetry.name;
    } catch {
      continue;
    }
    if (name === null) continue;
    out.push({
      name,
      dir,
      manager: "python",
      entryPoints: ["src/__init__.py", "__init__.py", "main.py", "__main__.py"].filter((p) =>
        existsSync(join(repoRoot, dir, p)),
      ),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function readJson(path: string): Record<string, unknown> | null {
  const text = readTextSafe(path);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function readTextSafe(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** 把 workspace glob（如 `packages/*`）展开成实际存在的目录列表 */
function expandGlobs(repoRoot: string, globs: string[]): string[] {
  const positive = globs.filter((g) => !g.startsWith("!"));
  const negative = globs.filter((g) => g.startsWith("!")).map((g) => g.slice(1));
  if (positive.length === 0) return [];

  const isMatch = picomatch(positive, { dot: false });
  const isExcluded = negative.length > 0 ? picomatch(negative, { dot: false }) : () => false;

  // glob 里最深的那一段决定要遍历几层，避免为 `packages/*` 走遍整个仓库
  const maxDepth = Math.max(
    ...positive.map((g) => (g.includes("**") ? 5 : g.split("/").length)),
  );

  const out: string[] = [];
  const visit = (absDir: string, relDir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (HARD_IGNORED_DIRS.has(entry) || entry.startsWith(".")) continue;
      const abs = join(absDir, entry);
      let isDir = false;
      try {
        isDir = statSync(abs).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const rel = relDir === "" ? entry : `${relDir}/${entry}`;
      if (isMatch(rel) && !isExcluded(rel)) out.push(rel);
      visit(abs, rel, depth + 1);
    }
  };
  visit(repoRoot, "", 1);
  return out;
}

/** 浅层查找指定文件名所在目录（仓库相对 posix 路径，根为 `.`） */
function findFilesNamed(repoRoot: string, filename: string, maxDepth: number): string[] {
  const out: string[] = [];
  const visit = (absDir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(absDir, { withFileTypes: true }).map((e) =>
        e.isDirectory() ? `d:${e.name}` : `f:${e.name}`,
      );
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.slice(2);
      if (entry.startsWith("f:")) {
        if (name === filename) {
          const rel = toPosix(relative(repoRoot, absDir));
          out.push(rel === "" ? "." : rel);
        }
        continue;
      }
      if (HARD_IGNORED_DIRS.has(name) || name.startsWith(".")) continue;
      visit(join(absDir, name), depth + 1);
    }
  };
  visit(repoRoot, 0);
  return out;
}

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function joinPosix(a: string, b: string): string {
  if (a === "." || a === "") return b;
  return `${a}/${b}`;
}
