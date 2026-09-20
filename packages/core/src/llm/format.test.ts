import { describe, expect, it } from "vitest";
import { normalizePseudocode, normalizeSummary } from "./format.js";

describe("AI semantic formatting", () => {
  it("把二次转义的换行恢复为真实摘要段落", () => {
    expect(normalizeSummary(
      "用途：解释兼容入口。\\r\\n\\r\\n核心概念：提供者（服务实现）。\\n\\n工作方式：注册并调用提供者。",
      2_000,
    )).toBe(
      "用途：解释兼容入口。\n\n核心概念：\n- 提供者（服务实现）。\n\n工作方式：\n1. 注册并调用提供者。",
    );
  });

  it("给旧缓存中没有标题的首段补上用途标签", () => {
    expect(normalizeSummary(
      "负责加载认证信息。\\n\\n核心概念：令牌（访问凭据）。",
      2_000,
    )).toBe("用途：负责加载认证信息。\n\n核心概念：\n- 令牌（访问凭据）。");
  });

  it("把字符串伪代码统一成编号步骤和缩进子步骤", () => {
    expect(normalizePseudocode(
      "导出兼容入口\\n注册内置提供者\\nstream(model)\\n  查找提供者\\n  返回流式结果",
      8_000,
      24,
    )).toBe(
      "1. 导出兼容入口\n2. 注册内置提供者\n3. stream(model)\n  - 查找提供者\n  - 返回流式结果",
    );
  });

  it("保留多行内容中用于说明代码的单个反斜杠 n", () => {
    expect(normalizePseudocode(
      "读取输入\n  将字符串 \\n 替换为空格",
      8_000,
    )).toContain("字符串 \\n 替换为空格");
  });

  it("把结构化模型响应渲染成固定格式", () => {
    expect(normalizeSummary({
      purpose: "加载用户配置。",
      keyConcepts: ["配置（运行参数）"],
      workflow: ["读取文件", "合并默认值"],
      notes: [],
    }, 2_000)).toBe(
      "用途：加载用户配置。\n\n核心概念：\n- 配置（运行参数）\n\n工作方式：\n1. 读取文件\n2. 合并默认值",
    );
    expect(normalizePseudocode([
      { step: "读取配置", details: ["文件不存在时使用默认值"] },
      { step: "返回结果", details: [] },
    ], 8_000)).toBe(
      "1. 读取配置\n  - 文件不存在时使用默认值\n2. 返回结果",
    );
  });
});
