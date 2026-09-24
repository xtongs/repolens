// 把桌面端需要的一切放进 app/，electron-builder 只打包这个目录。
//
//   node scripts/build.mjs          开发用：打包 JS、复制前端产物，运行时依赖从 pnpm 的 node_modules 解析
//   node scripts/build.mjs --stage  发布用：再把运行时依赖复制成扁平的 app/node_modules
//
// 主进程、preload、服务进程都用 esbuild 打成单个 CJS 文件。只有三个包留在外面：
// better-sqlite3（原生模块，按平台选预编译二进制）和两个 tree-sitter 包（运行时按
// 路径读 .wasm 文件）。它们都没法被打进 bundle。
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const appDir = join(root, "app");
const stage = process.argv.includes("--stage");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const RUNTIME_PACKAGES = Object.keys(pkg.dependencies);
/** 只在从源码编译原生模块时才用到；我们用的是预编译二进制 */
const BUILD_ONLY = new Set(["node-addon-api"]);
/** 源码、编译中间产物、调试版本和类型声明都不进安装包 */
const DROP_TOP_DIRS = new Set(["src", "deps", "build", "debug", "test", "docs"]);

const webDist = resolve(root, "../web/dist");
const scanWorker = resolve(root, "../server/dist/scan-worker.js");
for (const [path, hint] of [[webDist, "pnpm --filter @repolens/web build"], [scanWorker, "pnpm run build:node"]]) {
  if (!existsSync(path)) throw new Error(`缺少 ${relative(root, path)}，先运行 ${hint}`);
}

rmSync(appDir, { recursive: true, force: true });
mkdirSync(appDir, { recursive: true });

const common = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: stage ? false : "linked",
  logLevel: "warning",
};

// core 和 server 是 ESM，靠 import.meta.url 定位旁边的文件（扫描 worker、wasm 语法）。
// 打成 CJS 后换成产物文件自己的 URL，相对位置就和源码里一致。
const importMetaUrl = {
  banner: { js: 'const __importMetaUrl = require("node:url").pathToFileURL(__filename).href;' },
  define: { "import.meta.url": "__importMetaUrl" },
};

await Promise.all([
  build({ ...common, entryPoints: { main: "src/main.ts", preload: "src/preload.ts" }, outdir: appDir, external: ["electron"] }),
  build({
    ...common,
    ...importMetaUrl,
    // 文件名必须是 scan-worker.js：ScanManager 按这个名字在服务产物旁边找它
    entryPoints: { server: "src/server-process.ts", "scan-worker": scanWorker },
    outdir: appDir,
    external: ["electron", ...RUNTIME_PACKAGES],
  }),
]);

cpSync(webDist, join(appDir, "web"), { recursive: true });
cpSync(join(root, "build/icon.png"), join(appDir, "icon.png"));

writeFileSync(join(appDir, "package.json"), `${JSON.stringify({
  name: "repolens",
  productName: pkg.productName,
  version: pkg.version,
  description: pkg.description,
  author: pkg.author,
  homepage: pkg.homepage,
  main: "main.js",
  // 开发时依赖从上一级的 node_modules 解析；只有发布包里才需要声明
  ...(stage ? { dependencies: Object.fromEntries(RUNTIME_PACKAGES.map((name) => [name, pkg.dependencies[name]])) } : {}),
}, null, 2)}\n`);

if (stage) {
  const copied = new Set();
  for (const name of RUNTIME_PACKAGES) copyPackage(name, root, copied);
  console.log(`已复制运行时依赖：${[...copied].sort().join(", ")}`);
}

/** 按 Node 的查找规则找到包目录，连同它的运行时依赖一起复制成扁平结构 */
function copyPackage(name, fromDir, copied) {
  if (copied.has(name) || BUILD_ONLY.has(name)) return;
  const source = findPackageDir(name, fromDir);
  const target = join(appDir, "node_modules", ...name.split("/"));
  cpSync(source, target, { recursive: true, filter: (path) => keep(relative(source, path)) });
  copied.add(name);
  const meta = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  for (const dep of Object.keys(meta.dependencies ?? {})) copyPackage(dep, source, copied);
}

function findPackageDir(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", ...name.split("/"));
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`找不到依赖 ${name}（从 ${fromDir} 查找）`);
  }
}

function keep(rel) {
  if (rel === "") return true;
  const parts = rel.split(sep);
  if (DROP_TOP_DIRS.has(parts[0]) || parts.includes("node_modules")) return false;
  return !/\.(map|d\.c?ts|d\.mts|gyp)$/i.test(parts.at(-1));
}
