import { loadConfig, loadLock } from "./config.js";
import { unapprovedDependencies, type ModuleDependency } from "./db/architecture.js";
import { indexPath, openDb } from "./db/database.js";
import { buildChangeReport } from "./diff/report.js";
import { evaluateRules, type RuleReport } from "./pipeline/rules.js";
import { scanRepo, type ScanOptions } from "./pipeline/scan.js";
import type { ArchitectureLock, FindingChangeDto, RatchetKind } from "./types.js";

export interface CheckOptions {
  /** 和哪个提交比：给了才做棘轮检查 */
  baseline?: string | undefined;
  onProgress?: ScanOptions["onProgress"];
}

export interface CheckReport {
  rules: RuleReport[];
  lock: { level: ArchitectureLock["level"]; dependencies: number } | null;
  /** 依赖锁里没有的模块间依赖 */
  unapproved: ModuleDependency[];
  /** 相对基线新增的问题：按约定里的棘轮分成拦下的和只提示的 */
  ratchet: { base: { ref: string; commit: string }; failed: FindingChangeDto[]; warned: FindingChangeDto[] } | null;
  passed: boolean;
}

/**
 * 约定的全部检查，CLI、CI 和 MCP 用的是同一份：
 * 1. 依赖规则（.repolens.json 的 rules）
 * 2. 依赖锁（.repolens.lock.json）：锁里没有的模块间依赖要先批准
 * 3. 棘轮（给了基线时）：相对基线不许新增约定里拦下的那几类问题
 *
 * 先做一次只建结构的增量扫描，检查的永远是工作区里现在的代码。
 */
export async function runCheck(root: string, options: CheckOptions = {}): Promise<CheckReport> {
  const config = loadConfig(root);
  const lock = loadLock(root);
  await scanRepo({ root, structureOnly: true, onProgress: options.onProgress });

  const db = openDb(indexPath(root), { readonly: true });
  let rules: RuleReport[];
  let unapproved: ModuleDependency[];
  try {
    rules = evaluateRules(db, config.rules);
    unapproved = lock ? unapprovedDependencies(db, lock) : [];
  } finally {
    db.close();
  }

  let ratchet: CheckReport["ratchet"] = null;
  if (options.baseline) {
    const report = await buildChangeReport(root, { base: options.baseline, onProgress: options.onProgress });
    const added = report.findings.filter((finding) => finding.status === "added");
    const kindOf = (finding: FindingChangeDto) => finding.kind as RatchetKind;
    ratchet = {
      base: report.base,
      failed: added.filter((finding) => config.ratchet.fail.includes(kindOf(finding))),
      warned: added.filter((finding) => config.ratchet.warn.includes(kindOf(finding))),
    };
  }

  const rulesFailed = rules.some((report) => report.violations.length > 0 || report.checkedFiles === 0);
  return {
    rules,
    lock: lock ? { level: lock.level, dependencies: lock.dependencies.length } : null,
    unapproved,
    ratchet,
    passed: !rulesFailed && unapproved.length === 0 && (ratchet?.failed.length ?? 0) === 0,
  };
}
