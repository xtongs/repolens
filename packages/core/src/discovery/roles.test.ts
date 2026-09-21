import { describe, expect, it } from "vitest";
import { classifyRole } from "./roles.js";

describe("classifyRole", () => {
  it.each([
    [".prettierrc.js", "javascript"],
    ["tools/prettierrc.js", "javascript"],
    ["common/config/rush/command-line.json", "json"],
    ["fixtures/payload.json", "json"],
    [".cursor/rules/project.mdc", "other"],
    ["packages/app/.cursor/settings.json", "json"],
    ["build.sh", "shell"],
    ["apps/api/build.sh", "shell"],
  ] as const)("把 %s 归为默认隐藏的配置噪音", (path, language) => {
    expect(classifyRole(path, language)).toBe("config");
  });

  it("不把普通 shell 脚本或名字像配置的源码一并隐藏", () => {
    expect(classifyRole("scripts/deploy.sh", "shell")).toBe("source");
    expect(classifyRole("src/config.ts", "typescript")).toBe("source");
  });

  it("测试和生成目录仍优先于通用 JSON 规则", () => {
    expect(classifyRole("src/data.test.json", "json")).toBe("test");
    expect(classifyRole("dist/manifest.json", "json")).toBe("generated");
  });
});
