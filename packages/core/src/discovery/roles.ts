import picomatch from "picomatch";
import type { FileRole, Language } from "../types.js";

/**
 * 角色判定规则。顺序即优先级，第一个命中的规则决定角色。
 *
 * 这些规则直接决定了默认视图里出现什么，属于 docs/INTERACTION.md
 * 「删除」策略的实现细节，误判的代价是用户看不到自己想看的代码，
 * 所以宁可漏判（当成 source）也不要错判。
 */
interface RoleRule {
  role: FileRole;
  patterns: string[];
}

const RULES: RoleRule[] = [
  {
    role: "vendor",
    patterns: [
      "**/node_modules/**",
      "**/vendor/**",
      "**/third_party/**",
      "**/.venv/**",
      "**/site-packages/**",
    ],
  },
  {
    role: "test",
    patterns: [
      "**/*.test.*",
      "**/*.spec.*",
      "**/*_test.go",
      "**/*_test.py",
      "**/test_*.py",
      "**/__tests__/**",
      "**/__mocks__/**",
      "**/tests/**",
      "**/test/**",
      "**/e2e/**",
      "**/conftest.py",
      "**/*.bench.*",
      "**/benches/**",
    ],
  },
  {
    role: "generated",
    patterns: [
      "**/*.pb.go",
      "**/*_pb2.py",
      "**/*_pb2_grpc.py",
      "**/*.pb.ts",
      "**/*_grpc.pb.go",
      "**/*.generated.*",
      "**/*.gen.go",
      "**/generated/**",
      "**/__generated__/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/target/debug/**",
      "**/target/release/**",
      "**/*.min.js",
    ],
  },
  {
    role: "config",
    patterns: [
      "**/*.config.*",
      "**/*.conf.*",
      // JSON 通常承载配置、清单或静态数据，不包含可调用的程序逻辑。
      // 即使文件很大，把它画成源码节点也只会挤掉真正的实现文件。
      "**/*.json",
      "**/tsconfig*.json",
      "**/jsconfig*.json",
      "**/package.json",
      "**/pnpm-workspace.yaml",
      "**/go.mod",
      "**/go.sum",
      "**/Cargo.toml",
      "**/Cargo.lock",
      "**/pyproject.toml",
      "**/setup.py",
      "**/setup.cfg",
      "**/requirements*.txt",
      "**/Makefile",
      "**/Dockerfile*",
      "**/docker-compose*.y*ml",
      "**/*.lock",
      "**/.eslintrc*",
      "**/.prettierrc*",
      "**/prettierrc.*",
      "**/biome.json",
      // 只隐藏明确的构建入口；普通 shell 脚本仍可能是仓库的核心逻辑。
      "**/build.sh",
      "**/.github/**",
      "**/*.yaml",
      "**/*.yml",
      "**/*.toml",
      "**/*.ini",
    ],
  },
  {
    role: "docs",
    patterns: ["**/*.md", "**/*.mdx", "**/*.rst", "**/*.txt", "**/docs/**", "**/LICENSE*"],
  },
  {
    role: "asset",
    patterns: [
      "**/*.png",
      "**/*.jpg",
      "**/*.jpeg",
      "**/*.gif",
      "**/*.svg",
      "**/*.ico",
      "**/*.webp",
      "**/*.woff*",
      "**/*.ttf",
      "**/*.wasm",
      "**/*.node",
      "**/public/**",
      "**/assets/**",
    ],
  },
];

const MATCHERS = RULES.map((rule) => ({
  role: rule.role,
  match: picomatch(rule.patterns, { dot: true }),
}));

const D_TS = picomatch("**/*.d.ts", { dot: true });

/**
 * 判定文件角色。
 *
 * `language` 参与判定是因为纯类型声明文件（`.d.ts`）在扩展名上和 TS 源码一样，
 * 但在依赖图上的意义完全不同——它们不含运行时逻辑，画进调用图只会增加噪音。
 */
export function classifyRole(path: string, language: Language): FileRole {
  for (const { role, match } of MATCHERS) {
    if (match(path)) return role;
  }
  if (D_TS(path)) return "types";
  if (language === "other") return "asset";
  return "source";
}

/** 纯类型声明文件：被 import 时不产生运行时依赖 */
export function isTypeDeclaration(path: string): boolean {
  return D_TS(path) || path.endsWith(".pyi");
}
