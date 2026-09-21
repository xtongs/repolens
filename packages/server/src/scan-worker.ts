import { scanRepo, type ScanPhase } from "@repolens/core";
import { parentPort, workerData } from "node:worker_threads";

interface WorkerInput {
  root: string;
}

type WorkerMessage =
  | { type: "progress"; phase: ScanPhase; done: number; total: number }
  | { type: "completed" }
  | { type: "failed"; error: string };

const port = parentPort;
if (port === null) throw new Error("扫描 worker 缺少父线程");

const { root } = workerData as WorkerInput;

try {
  await scanRepo({
    root,
    onProgress: (phase, done, total) => {
      port.postMessage({ type: "progress", phase, done, total } satisfies WorkerMessage);
    },
  });
  port.postMessage({ type: "completed" } satisfies WorkerMessage);
} catch (err) {
  port.postMessage({
    type: "failed",
    error: err instanceof Error ? err.message : String(err),
  } satisfies WorkerMessage);
}
