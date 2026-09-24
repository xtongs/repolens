import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, globalConfigPath, loadConfig } from "./config.js";

const roots: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

describe("loadConfig", () => {
  it("按默认值、全局配置、仓库配置的顺序继承", () => {
    const configHome = tempDir("repolens-global-config-");
    const repo = tempDir("repolens-config-repo-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      maxNodesPerView: 44,
      roleOverrides: { "legacy/**": "generated", "bad/**": "unknown" },
      llm: {
        baseUrl: "http://127.0.0.1:8317/v1/",
        model: "global-model",
        apiKeyEnv: "SHARED_KEY",
        maxConcurrency: 7,
      },
    }));
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({
      exclude: ["fixtures/**"],
      roleOverrides: { "runtime/**/*.json": "source" },
      llm: { model: "repo-model", enabled: false },
    }));

    const config = loadConfig(repo);
    expect(globalConfigPath()).toBe(join(configHome, "repolens/config.json"));
    expect(config.exclude).toEqual(["fixtures/**"]);
    expect(config.maxNodesPerView).toBe(44);
    expect(config.roleOverrides).toEqual({
      "legacy/**": "generated",
      "runtime/**/*.json": "source",
    });
    expect(config.llm).toMatchObject({
      baseUrl: "http://127.0.0.1:8317/v1",
      model: "repo-model",
      apiKeyEnv: "SHARED_KEY",
      maxConcurrency: 7,
      enabled: false,
    });
    expect(config.llm.requestTimeoutMs).toBe(DEFAULT_CONFIG.llm.requestTimeoutMs);
  });

  it("仓库级配置不能改服务地址和 key 变量名", () => {
    const configHome = tempDir("repolens-global-config-");
    const repo = tempDir("repolens-config-repo-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(configHome, "repolens"));
    writeFileSync(join(configHome, "repolens/config.json"), JSON.stringify({
      llm: { baseUrl: "https://llm.example.com/v1", apiKeyEnv: "SHARED_KEY" },
    }));
    writeFileSync(join(repo, ".repolens.json"), JSON.stringify({
      llm: { baseUrl: "https://attacker.example/v1", apiKeyEnv: "AWS_SECRET_ACCESS_KEY", model: "repo-model" },
    }));

    expect(loadConfig(repo).llm).toMatchObject({
      baseUrl: "https://llm.example.com/v1",
      apiKeyEnv: "SHARED_KEY",
      model: "repo-model",
    });
  });

  it("没有任何配置时使用独立的默认值副本", () => {
    vi.stubEnv("XDG_CONFIG_HOME", tempDir("repolens-empty-config-"));
    const first = loadConfig(tempDir("repolens-empty-repo-"));
    first.exclude.push("changed");
    const second = loadConfig(tempDir("repolens-empty-repo-"));
    expect(second).toEqual(DEFAULT_CONFIG);
  });

  it("解析失败时报告具体配置路径", () => {
    const configHome = tempDir("repolens-bad-config-");
    const repo = tempDir("repolens-bad-repo-");
    vi.stubEnv("XDG_CONFIG_HOME", configHome);
    mkdirSync(join(configHome, "repolens"));
    const path = join(configHome, "repolens/config.json");
    writeFileSync(path, "{ bad json");
    expect(() => loadConfig(repo)).toThrow(path);
  });
});
