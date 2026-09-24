import type { ParentPort } from "electron";
import { startServer } from "@repolens/server";
import type { FromServer, ToServer } from "./ipc.js";

/**
 * 跑在 Electron utilityProcess 里的本地服务。
 *
 * 和命令行的 `repolens serve` 是同一个服务，区别只在启动参数：不指定启动仓库
 * （仓库全部来自清单），端口由系统分配，每个 /api 请求都要带主进程下发的令牌，
 * 目录选择交给主进程弹原生对话框。放在独立进程里，扫描和 SQLite 查询再重也
 * 不会卡住窗口。
 */
const port = (process as NodeJS.Process & { parentPort: ParentPort }).parentPort;
const pendingPicks = new Map<number, (path: string | null) => void>();
let nextPickId = 1;

function send(message: FromServer): void {
  port.postMessage(message);
}

function pickDirectory(): Promise<string | null> {
  return new Promise((resolve) => {
    const id = nextPickId++;
    pendingPicks.set(id, resolve);
    send({ type: "pick-directory", id });
  });
}

async function start(accessToken: string, webRoot: string): Promise<void> {
  try {
    const server = await startServer({ repoRoot: null, port: 0, webRoot, accessToken, pickDirectory });
    send({ type: "ready", port: server.port });
  } catch (err) {
    send({ type: "failed", error: (err as Error).message });
  }
}

port.on("message", ({ data }: { data: ToServer }) => {
  if (data.type === "start") {
    void start(data.accessToken, data.webRoot);
  } else if (data.type === "picked") {
    pendingPicks.get(data.id)?.(data.path);
    pendingPicks.delete(data.id);
  } else if (data.type === "env") {
    for (const [name, value] of Object.entries(data.values)) {
      if (value === null) delete process.env[name];
      else process.env[name] = value;
    }
    send({ type: "env-applied", id: data.id });
  }
});
