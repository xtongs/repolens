// 生成安装包：先准备 app/，再调用 electron-builder，其余参数原样转交。
//
//   node scripts/dist.mjs --dir              只生成可运行的应用目录，不做安装包
//   node scripts/dist.mjs --publish always   打包并上传到 GitHub Releases 草稿（需要 GH_TOKEN）
//
// 签名证书通过环境变量提供（CSC_LINK / CSC_KEY_PASSWORD，公证用 APPLE_ID 等），都留空时：
// macOS 用 ad-hoc 签名。Apple 芯片的 Mac 会把完全没签名的应用报成“已损坏”，
// ad-hoc 签名后只是提示“无法验证开发者”，用户在系统设置里放行即可。
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SIGNING_ENV = [
  "CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME", "WIN_CSC_LINK", "WIN_CSC_KEY_PASSWORD",
  "APPLE_ID", "APPLE_APP_SPECIFIC_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_KEY_ID", "APPLE_API_ISSUER",
];

// CI 里没配置的 secret 会展开成空字符串，electron-builder 会把它当成配置了但无效
const env = { ...process.env };
for (const name of SIGNING_ENV) if (env[name]?.trim() === "") delete env[name];

const args = process.argv.slice(2);
if (process.platform === "darwin" && env.CSC_LINK === undefined && env.CSC_NAME === undefined) {
  args.push("-c.mac.identity=-");
}

run(["scripts/build.mjs", "--stage"]);
run([join(root, "node_modules/electron-builder/cli.js"), ...args]);

function run(argv) {
  const result = spawnSync(process.execPath, argv, { cwd: root, env, stdio: "inherit" });
  if (result.status !== 0) process.exit(result.status ?? 1);
}
