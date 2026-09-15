import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const require = createRequire(import.meta.url);

/**
 * 定位前端构建产物。
 *
 * 由 CLI 而不是 server 负责查找：server 是一个纯粹的 API 层，让它反向
 * 依赖 UI 包会把依赖方向搞反。CLI 是最终交付物，知道 UI 在哪是它的职责。
 */
export function locateWebDist(): string | null {
  const candidates: string[] = [];

  try {
    candidates.push(resolve(dirname(require.resolve("@repolens/web/package.json")), "dist"));
  } catch {
    // 未安装 workspace 链接时走下面的相对路径兜底
  }

  // monorepo 内直接从源码运行时的位置：packages/cli/dist/../../web/dist
  candidates.push(resolve(dirname(new URL(import.meta.url).pathname), "../../web/dist"));

  return candidates.find((dir) => existsSync(resolve(dir, "index.html"))) ?? null;
}

export function webAssetsHint(): string {
  return "前端尚未构建，运行 `pnpm --filter @repolens/web build` 后重试。";
}
