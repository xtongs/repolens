import type { RuleReport } from "@repolens/core";

const LIMIT = 20;

export const RULES_HINT = `没有声明依赖规则。在仓库根目录的 .repolens.json 里加上 rules，例如：

  {
    "rules": [
      {
        "name": "前端不直接依赖服务端",
        "from": "packages/web/**",
        "disallow": ["packages/server/**", "better-sqlite3"],
        "reason": "前端只经 HTTP API 访问服务端"
      }
    ]
  }

disallow 可以写仓库内路径 glob，也可以写外部包名；allow 列例外；纯类型 import 默认放行，
需要一并禁止时加 "includeTypeOnly": true。
`;

/** 规则没覆盖到任何文件也算失败：多半是 glob 写错，放过去就等于没有这条规则 */
export function rulesFailed(reports: readonly RuleReport[]): boolean {
  return reports.some((report) => report.violations.length > 0 || report.checkedFiles === 0);
}

export function formatRuleReports(reports: readonly RuleReport[]): string {
  const violated = reports.filter((report) => report.violations.length > 0);
  const empty = reports.filter((report) => report.checkedFiles === 0);
  const total = violated.reduce((sum, report) => sum + report.violations.length, 0);

  const lines: string[] = [];
  const verdict = violated.length === 0 && empty.length === 0
    ? "全部通过"
    : [violated.length > 0 ? `${violated.length} 条有违规（共 ${total} 处）` : "", empty.length > 0 ? `${empty.length} 条没有覆盖任何文件` : ""]
      .filter(Boolean)
      .join("，");
  lines.push(`依赖规则  ${reports.length} 条 · ${verdict}`, "");

  for (const report of reports) {
    if (report.checkedFiles === 0) {
      lines.push(`  ! ${report.label}`);
      lines.push("      from 没有匹配任何源码文件，检查路径写法（相对仓库根目录）");
      continue;
    }
    const mark = report.violations.length > 0 ? "✗" : "✓";
    lines.push(`  ${mark} ${report.label}  检查 ${report.checkedFiles} 个文件${report.violations.length > 0 ? `，${report.violations.length} 处越界` : ""}`);
    if (report.violations.length === 0) continue;
    if (report.rule.reason) lines.push(`      ${report.rule.reason}`);
    for (const violation of report.violations.slice(0, LIMIT)) {
      lines.push(`      ${violation.filePath}:${violation.line} → ${violation.target}${violation.typeOnly ? "（仅类型）" : ""}`);
    }
    if (report.violations.length > LIMIT) lines.push(`      … 另有 ${report.violations.length - LIMIT} 处`);
  }
  lines.push("");
  return lines.join("\n");
}
