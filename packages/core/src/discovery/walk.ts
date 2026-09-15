import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";
import type { DiscoveredFile, DiscoveredPackage, RepolensConfig } from "../types.js";
import { buildIgnoreMatcher, HARD_IGNORED_DIRS } from "./ignore.js";
import { detectLanguage } from "./language.js";
import { classifyRole } from "./roles.js";

export interface WalkResult {
  files: DiscoveredFile[];
  /** 所有出现过的目录（仓库相对 posix，不含根） */
  directories: string[];
  skippedTooLarge: number;
}

/**
 * 遍历仓库并对每个文件做语言检测、角色分类、内容哈希。
 *
 * 哈希在这里就算，而不是等到解析阶段：增量扫描要靠它判断文件是否变了，
 * 而「没变」的文件根本不需要读第二遍。
 */
export function walkRepo(
  repoRoot: string,
  config: RepolensConfig,
  packages: readonly DiscoveredPackage[],
): WalkResult {
  const ignore = buildIgnoreMatcher(repoRoot, config.exclude, config.include);
  const packageDirs = [...packages]
    .map((p) => p.dir)
    .sort((a, b) => b.length - a.length); // 最长前缀优先，嵌套包归属到最内层

  const files: DiscoveredFile[] = [];
  const directories = new Set<string>();
  let skippedTooLarge = 0;

  const visit = (absDir: string, relDir: string): void => {
    for (const entry of readdirSafe(absDir)) {
      const name = entry.name;
      const rel = relDir === "" ? name : `${relDir}/${name}`;

      if (entry.isSymbolicLink()) continue; // 软链会导致环，直接跳过

      if (entry.isDirectory()) {
        if (HARD_IGNORED_DIRS.has(name)) continue;
        if (ignore.ignores(`${rel}/`)) continue;
        directories.add(rel);
        visit(join(absDir, name), rel);
        continue;
      }

      if (!entry.isFile()) continue;
      if (ignore.ignores(rel)) continue;

      const language = detectLanguage(rel);
      const role = classifyRole(rel, language);
      if (role === "vendor") continue;

      const abs = join(absDir, name);
      let bytes: number;
      try {
        bytes = statSync(abs).size;
      } catch {
        continue;
      }

      if (bytes > config.maxFileBytes) {
        skippedTooLarge++;
        continue;
      }

      // 二进制资源不需要内容哈希，用 size 当指纹足够
      const hash =
        role === "asset"
          ? `size:${bytes}`
          : hashContent(readFileSafe(abs));

      files.push({
        path: rel,
        language,
        role,
        bytes,
        hash,
        packageDir: packageDirs.find((dir) => dir === "." || rel.startsWith(`${dir}/`)) ?? null,
      });
    }
  };

  visit(repoRoot, "");

  return {
    files: files.sort((a, b) => a.path.localeCompare(b.path)),
    directories: [...directories].sort(),
    skippedTooLarge,
  };
}

function readdirSafe(absDir: string): Dirent[] {
  try {
    return readdirSync(absDir, { withFileTypes: true });
  } catch {
    // 权限不足或竞态删除都不该中断整次遍历
    return [];
  }
}

function readFileSafe(abs: string): Buffer {
  try {
    return readFileSync(abs);
  } catch {
    return Buffer.alloc(0);
  }
}

export function hashContent(content: Buffer | string): string {
  return createHash("sha1").update(content).digest("hex").slice(0, 16);
}
