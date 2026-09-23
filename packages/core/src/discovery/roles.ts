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
      "**/third-party/**",
      "**/thirdparty/**",
      "**/3rd_party/**",
      "**/3rd-party/**",
      "**/bower_components/**",
      "**/jspm_packages/**",
      "**/web_modules/**",
      "**/.yarn/cache/**",
      "**/.yarn/unplugged/**",
      "**/.yarn/sdks/**",
      "**/Godeps/_workspace/**",
      "**/Pods/**",
      "**/Carthage/Build/**",
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
      "**/__fixtures__/**",
      "**/__snapshots__/**",
      "**/*.snap",
      "**/testdata/**",
      "**/test-data/**",
      "**/{test,tests,spec,specs}/fixtures/**",
      "**/*.stories.*",
      "**/*.story.*",
      "**/integration-tests/**",
      "**/integration_test/**",
    ],
  },
  {
    role: "generated",
    patterns: [
      "**/*.pb.go",
      "**/*_pb2.py",
      "**/*_pb2_grpc.py",
      "**/*.pb.ts",
      "**/*.pb.js",
      "**/*_pb.js",
      "**/*.pb.rs",
      "**/*_grpc.pb.go",
      "**/*.generated.*",
      "**/*.gen.*",
      "**/*.gen.go",
      "**/*_generated.py",
      "**/*.designer.*",
      "**/*.feature.cs",
      "**/generated/**",
      "**/__generated__/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/target/debug/**",
      "**/target/release/**",
      "**/*.min.js",
      "**/*.min.css",
      "**/*.js.map",
      "**/*.css.map",
      "**/htmlcov/**",
      "**/storybook-static/**",
      "**/.docusaurus/**",
      "**/.vitepress/cache/**",
      "**/.vitepress/dist/**",
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
      "**/*.jsonc",
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
      "**/.babelrc*",
      "**/.stylelintrc*",
      "**/.commitlintrc*",
      "**/.lintstagedrc*",
      "**/.editorconfig",
      "**/.gitignore",
      "**/.gitattributes",
      "**/.gitmodules",
      "**/.ignore",
      "**/.repolensignore",
      "**/.dockerignore",
      "**/.npmignore",
      "**/.prettierignore",
      "**/.eslintignore",
      "**/.stylelintignore",
      "**/.npmrc",
      "**/.yarnrc*",
      "**/.nvmrc",
      "**/.tool-versions",
      "**/biome.json",
      "**/.cursor/**",
      "**/.vscode/**",
      "**/.devcontainer/**",
      "**/.fleet/**",
      "**/.zed/**",
      "**/.obsidian/**",
      "**/.teamcity/**",
      "**/.circleci/**",
      "**/.husky/**",
      "**/.changeset/**",
      "**/.storybook/**",
      "**/.env",
      "**/.env.*",
      // 只隐藏明确的构建入口；普通 shell 脚本仍可能是仓库的核心逻辑。
      "**/build.sh",
      "**/.github/**",
      "**/*.yaml",
      "**/*.yml",
      "**/*.toml",
      "**/*.ini",
      "**/go.work",
      "**/go.work.sum",
      "**/Pipfile*",
      "**/Gemfile*",
      "**/pom.xml",
      "**/build.gradle*",
      "**/settings.gradle*",
      "**/gradle.properties",
      "**/WORKSPACE*",
      "**/BUILD",
      "**/BUILD.bazel",
      "**/*.csproj",
      "**/*.fsproj",
      "**/*.vbproj",
      "**/*.sln",
      "**/Taskfile*",
      "**/Justfile",
      "**/Procfile",
      "**/Vagrantfile",
      "**/Jenkinsfile",
    ],
  },
  {
    role: "docs",
    patterns: [
      "**/*.md",
      "**/*.mdx",
      "**/*.rst",
      "**/*.txt",
      "**/docs/**",
      "**/documentation/**",
      "**/javadoc/**",
      "**/README*",
      "**/CHANGELOG*",
      "**/CHANGES*",
      "**/CONTRIBUTING*",
      "**/CODE_OF_CONDUCT*",
      "**/SECURITY*",
      "**/AUTHORS*",
      "**/NOTICE*",
      "**/COPYING*",
      "**/LICENSE*",
    ],
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
      "**/*.pdf",
      "**/*.{zip,gz,tgz,bz2,xz,7z,rar,tar}",
      "**/*.{mp3,mp4,m4a,mov,avi,webm,wav,flac,ogg}",
      "**/*.{eot,otf,doc,docx,xls,xlsx,ppt,pptx}",
      "**/*.{exe,dll,dylib,so,a,o,obj,class,jar}",
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
const PYI = picomatch("**/*.pyi", { dot: true });

export type RoleClassifier = (path: string, language: Language, source?: string) => FileRole;

/** 创建带显式覆盖的分类器；后写的 glob 优先，便于仓库配置覆盖全局配置。 */
export function createRoleClassifier(overrides: Record<string, FileRole>): RoleClassifier {
  const explicit = Object.entries(overrides)
    .map(([pattern, role]) => ({ role, match: picomatch(pattern, { dot: true }) }))
    .reverse();
  return (path, language, source) => {
    for (const item of explicit) if (item.match(path)) return item.role;
    return classifyRole(path, language, source);
  };
}

/**
 * 判定文件角色。
 *
 * `language` 参与判定是因为纯类型声明文件（`.d.ts`）在扩展名上和 TS 源码一样，
 * 但在依赖图上的意义完全不同——它们不含运行时逻辑，画进调用图只会增加噪音。
 */
export function classifyRole(path: string, language: Language, source?: string): FileRole {
  for (const { role, match } of MATCHERS) {
    if (match(path)) return role;
  }
  if (D_TS(path) || PYI(path)) return "types";
  if (source !== undefined && isGeneratedSource(source)) return "generated";
  // 未知后缀不再一律视为资源：很多小众语言、无后缀脚本和 DSL 都是可读源码。
  // 只有内容检测确认是二进制才隐藏，文本文件仍可统计、浏览和交给 AI 理解。
  if (language === "other" && source !== undefined && !isProbablyText(source)) return "asset";
  return "source";
}

/** GitHub Linguist 同类的保守文本检测：NUL 必为二进制，控制字符比例过高也隐藏。 */
function isProbablyText(source: string): boolean {
  if (source.includes("\0")) return false;
  const sample = source.slice(0, 8_000);
  if (sample.length === 0) return true;
  let controls = 0;
  let replacement = 0;
  for (const char of sample) {
    const code = char.charCodeAt(0);
    if (char === "�") replacement++;
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x0c) controls++;
  }
  return controls / sample.length < 0.01 && replacement / sample.length < 0.02;
}

/**
 * 只检查源码开头的高置信度生成标记。GitHub Linguist 和 scc 都把
 * “generated / do not edit” 作为路径规则之外的第二证据；限制在前 40 行，
 * 避免业务字符串或生成器模板正文里偶然出现这些词时误判。
 */
function isGeneratedSource(source: string): boolean {
  const lines = source.slice(0, 12_000).split(/\r?\n/, 40);
  const marker = /(?:code\s+generated[^\n]{0,160}do\s+not\s+edit|<auto-generated(?:\s|\/|>)|@generated\b|(?:this\s+file\s+(?:is|was)|file\s+was)\s+(?:automatically\s+|auto[- ]?)?generated|(?:auto[- ]?|automatically\s+)generated[^\n]{0,160}do\s+not\s+edit|generated\s+file[^\n]{0,120}do\s+not\s+edit)/i;
  return lines.some((line) => {
    const comment = /^\s*(?:\/\/|#|\/\*+|\*|<!--)\s?(.*)$/.exec(line);
    return comment?.[1] !== undefined && marker.test(comment[1]);
  });
}

/** 纯类型声明文件：被 import 时不产生运行时依赖 */
export function isTypeDeclaration(path: string): boolean {
  return D_TS(path) || PYI(path);
}
