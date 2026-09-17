import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb } from "../db/database.js";
import { getEntryPoints, getTrace, getTraceSummaries } from "../db/traces.js";
import { generateTraceNarrative } from "../llm/enrich.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("M4 trace analysis", () => {
  it("识别 Express 路由并沿确定调用边追到数据库", async () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-trace-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "trace-fixture", type: "module" }));
    writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
    writeFileSync(join(root, "src/server.ts"), `
      import express from "express";
      const app = express();
      const db = { query(sql: string, args: unknown[]): User { throw new Error(sql); } };
      type User = { id: string };

      export function getUser(req: { params: { id: string } }, res: unknown): User {
        return loadUser(req.params.id);
      }

      function loadUser(id: string): User {
        return db.query("SELECT * FROM users WHERE id = ?", [id]);
      }

      app.get("/users/:id", getUser);
    `);

    await scanRepo({ root, fresh: true });
    const db = openDb(indexPath(root), { readonly: true });
    try {
      const route = getEntryPoints(db).find((entry) => entry.kind === "http");
      expect(route).toMatchObject({
        label: "GET /users/:id", method: "GET", route: "/users/:id",
        confidence: "exact", framework: "Express-compatible", traceCount: 1,
      });
      expect(route?.symbolId).toMatch(/^sym:/);

      const summaries = getTraceSummaries(db, Number(route?.id.split(":")[1]));
      expect(summaries).toHaveLength(1);
      expect(summaries[0]).toMatchObject({ boundaryKind: "database", confidence: "exact", steps: 3 });

      const trace = getTrace(db, Number(summaries[0]?.id.split(":")[1]));
      expect(trace?.orderedSteps.map((step) => [step.kind, step.label, step.source])).toEqual([
        ["entry", "GET /users/:id", "deterministic"],
        ["call", "loadUser", "deterministic"],
        ["boundary", "数据库 · db.query", "deterministic"],
      ]);
      expect(trace?.orderedSteps[1]?.arguments).toEqual(["req.params.id"]);
      expect(trace?.orderedSteps[2]?.arguments).toEqual(["\"SELECT * FROM users WHERE id = ?\"", "[id]"]);
      expect(trace?.typeFlows.some((flow) => flow.type === "User")).toBe(true);
    } finally { db.close(); }
  });

  it("把无法由类型系统证明的方法跳转标为推断步骤", async () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-trace-likely-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "trace-likely", type: "module" }));
    writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
    writeFileSync(join(root, "src/service.ts"), `
      const db = { query(sql: string): User { throw new Error(sql); } };
      export type User = { id: string };
      export class UserService {
        loadUser(id: string): User {
          return db.query("SELECT * FROM users");
        }
      }
    `);
    writeFileSync(join(root, "src/server.ts"), `
      import express from "express";
      import { UserService } from "./service.js";
      const app = express();
      const service = new UserService();
      function getUser(req: { params: { id: string } }): unknown {
        return service.loadUser(req.params.id);
      }
      app.get("/users/:id", getUser);
    `);

    await scanRepo({ root, fresh: true });
    const db = openDb(indexPath(root), { readonly: true });
    try {
      const route = getEntryPoints(db).find((entry) => entry.kind === "http");
      const summary = getTraceSummaries(db, Number(route?.id.split(":")[1]))[0];
      const trace = getTrace(db, Number(summary?.id.split(":")[1]));
      expect(summary?.confidence).toBe("likely");
      expect(trace?.orderedSteps.find((step) => step.label === "UserService.loadUser")).toMatchObject({
        confidence: "likely",
        source: "inferred",
        arguments: ["req.params.id"],
        filePath: "src/service.ts",
        callSite: { filePath: "src/server.ts" },
      });
      expect(trace?.orderedSteps.at(-1)).toMatchObject({ source: "deterministic", confidence: "exact" });
    } finally { db.close(); }
  });

  it("按链路指纹缓存 LLM 叙述", async () => {
    const root = mkdtempSync(join(tmpdir(), "repolens-trace-ai-"));
    roots.push(root);
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "trace-ai", type: "module" }));
    const configPath = join(root, ".repolens.json");
    writeFileSync(configPath, JSON.stringify({ llm: { enabled: false } }));
    writeFileSync(join(root, "src/server.ts"), `
      const app = { get(path: string, handler: unknown): void {} };
      const db = { query(sql: string): string { return sql; } };
      function handler(id: string): string { return load(id); }
      function load(id: string): string { return db.query(id); }
      app.get("/items/:id", handler);
    `);
    await scanRepo({ root, fresh: true });
    writeFileSync(configPath, JSON.stringify({
      llm: {
        enabled: true, baseUrl: "http://llm.invalid/v1", model: "trace-test",
        apiKeyEnv: "", outputLanguage: "zh", maxRetries: 0,
      },
    }));

    let requests = 0;
    vi.stubGlobal("fetch", async () => {
      requests++;
      return new Response(JSON.stringify({
        choices: [{ message: { content: JSON.stringify({
          summary: "请求经过处理器和加载函数后访问数据库。",
          steps: [
            { ordinal: 0, narrative: "接收路由请求。", parameterFlow: "id 进入处理器" },
            { ordinal: 1, narrative: "加载数据。", parameterFlow: "id 继续传递" },
            { ordinal: 2, narrative: "执行数据库查询。", parameterFlow: "id 作为查询参数" },
          ],
        }) } }],
        usage: { prompt_tokens: 30, completion_tokens: 20, total_tokens: 50 },
      }), { status: 200, headers: { "content-type": "application/json" } });
    });

    const db = openDb(indexPath(root));
    try {
      const entry = getEntryPoints(db).find((item) => item.kind === "http");
      const trace = getTraceSummaries(db, Number(entry?.id.split(":")[1]))[0];
      const id = Number(trace?.id.split(":")[1]);
      const first = await generateTraceNarrative(db, root, id);
      const second = await generateTraceNarrative(db, root, id);
      expect(first).toMatchObject({ generated: true, cacheHit: false, model: "trace-test" });
      expect(first.narrative.steps).toHaveLength(3);
      expect(second).toMatchObject({ generated: false, cacheHit: true });
      expect(getTrace(db, id)?.narrative?.summary).toBe("请求经过处理器和加载函数后访问数据库。");
      expect(requests).toBe(1);
    } finally { db.close(); }
  });
});
