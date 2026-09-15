#!/usr/bin/env node
import {
  indexPath,
  openDb,
  getOverview,
  rememberRepo,
  scanRepo,
  type ScanPhase,
} from "@repolens/core";
import { DEFAULT_PORT, startServer } from "@repolens/server";
import { Command } from "commander";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import open from "open";
import { formatOverview, formatScanReport, progressBar } from "./report.js";
import { locateWebDist, webAssetsHint } from "./web-assets.js";

const program = new Command();

program
  .name("repolens")
  .description("本地代码仓库理解工具：扫描仓库并在浏览器里可视化架构、结构与调用关系")
  .version("0.1.0");

program
  .command("scan", { isDefault: false })
  .description("扫描仓库并写入 .repolens/index.db")
  .argument("[path]", "仓库路径", ".")
  .option("-f, --fresh", "忽略已有索引，全量重建", false)
  .option("-q, --quiet", "只输出最终结果", false)
  .action(async (path: string, opts: { fresh: boolean; quiet: boolean }) => {
    const root = resolve(path);
    assertDirectory(root);

    const stats = await scanRepo({
      root,
      fresh: opts.fresh,
      onProgress: opts.quiet ? undefined : reportProgress,
    });

    if (!opts.quiet) process.stderr.write("\n");
    process.stdout.write(formatScanReport(root, stats));
    remember(root);
  });

program
  .command("serve")
  .description("启动本地服务浏览已有索引")
  .argument("[path]", "仓库路径", ".")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .option("--host <host>", "监听地址", "127.0.0.1")
  .option("--open", "启动后打开浏览器", false)
  .action(async (path: string, opts: { port: string; host: string; open: boolean }) => {
    const root = resolve(path);
    remember(root);
    const webRoot = locateWebDist();
    if (webRoot === null) process.stderr.write(`${webAssetsHint()}\n`);

    const server = await startServer({
      repoRoot: root,
      port: Number.parseInt(opts.port, 10),
      host: opts.host,
      webRoot: webRoot ?? undefined,
    });
    process.stdout.write(`RepoLens 已启动：${server.url}\n按 Ctrl+C 停止\n`);
    if (opts.open) await open(server.url);

    const shutdown = () => {
      void server.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("open")
  .description("扫描（必要时）后启动服务并打开浏览器")
  .argument("[path]", "仓库路径", ".")
  .option("-p, --port <port>", "端口", String(DEFAULT_PORT))
  .option("-f, --fresh", "强制全量重扫", false)
  .action(async (path: string, opts: { port: string; fresh: boolean }) => {
    const root = resolve(path);
    assertDirectory(root);

    const needsScan = opts.fresh || !existsSync(indexPath(root));
    if (needsScan) {
      const stats = await scanRepo({ root, fresh: opts.fresh, onProgress: reportProgress });
      process.stderr.write("\n");
      process.stdout.write(formatScanReport(root, stats));
    }
    remember(root);

    const webRoot = locateWebDist();
    if (webRoot === null) process.stderr.write(`${webAssetsHint()}\n`);

    const server = await startServer({
      repoRoot: root,
      port: Number.parseInt(opts.port, 10),
      webRoot: webRoot ?? undefined,
    });
    process.stdout.write(`\nRepoLens 已启动：${server.url}\n按 Ctrl+C 停止\n`);
    await open(server.url);

    const shutdown = () => {
      void server.close().then(() => process.exit(0));
    };
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program
  .command("info")
  .description("打印已有索引的摘要")
  .argument("[path]", "仓库路径", ".")
  .action((path: string) => {
    const root = resolve(path);
    const dbPath = indexPath(root);
    if (!existsSync(dbPath)) {
      process.stderr.write(`索引不存在：${dbPath}\n先运行 \`repolens scan ${path}\`\n`);
      process.exit(1);
    }
    const db = openDb(dbPath, { readonly: true });
    process.stdout.write(formatOverview(getOverview(db)));
    db.close();
  });

const PHASE_LABELS: Record<ScanPhase, string> = {
  discover: "发现文件",
  parse: "解析语法",
  resolve: "解析依赖",
  link: "链接图谱",
  rollup: "聚合指标",
  index: "建立索引",
};

let lastPhase: ScanPhase | null = null;

function reportProgress(phase: ScanPhase, done: number, total: number): void {
  if (!process.stderr.isTTY) {
    if (phase !== lastPhase) {
      process.stderr.write(`${PHASE_LABELS[phase]}…\n`);
      lastPhase = phase;
    }
    return;
  }
  const label = PHASE_LABELS[phase].padEnd(8, " ");
  process.stderr.write(`\r${label} ${progressBar(done, total)} ${done}/${total}   `);
}

/**
 * 记进「扫过的仓库」清单，界面的仓库选择器就是读它。
 *
 * 失败不该影响主流程：清单只是个便利缓存，home 目录不可写（容器、受限
 * 环境）时扫描和浏览本身完全不受影响，没理由为它中断。
 */
function remember(root: string): void {
  try {
    rememberRepo(root);
  } catch (err) {
    process.stderr.write(`（仓库清单未能更新：${(err as Error).message}）\n`);
  }
}

function assertDirectory(root: string): void {
  if (!existsSync(root)) {
    process.stderr.write(`路径不存在：${root}\n`);
    process.exit(1);
  }
}

await program.parseAsync(process.argv);
