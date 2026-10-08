import { existsSync } from "node:fs";
import { indexPath, isIndexCurrent, openDb } from "../db/database.js";
import type { ScanOptions } from "../pipeline/scan.js";
import type { ChangeReportDto } from "../types.js";
import { BaselineError, buildBaseline } from "./baseline.js";
import { diffIndexes } from "./compare.js";

export interface ChangeReportOptions {
  /** 基线：任意 git 提交写法（HEAD、main、HEAD~3、sha） */
  base: string;
  /** 缺省时对比工作区的当前索引（调用方负责先扫描） */
  head?: string | undefined;
  onProgress?: ScanOptions["onProgress"];
}

export async function buildChangeReport(root: string, options: ChangeReportOptions): Promise<ChangeReportDto> {
  const base = await buildBaseline(root, options.base, options.onProgress);
  const head = options.head ? await buildBaseline(root, options.head, options.onProgress) : null;
  const headPath = head?.dbPath ?? indexPath(root);
  if (!existsSync(headPath) || !isIndexCurrent(headPath)) {
    throw new BaselineError("当前索引不存在或已过期，先运行一次扫描");
  }

  const baseDb = openDb(base.dbPath, { readonly: true });
  const headDb = openDb(headPath, { readonly: true });
  try {
    return diffIndexes(baseDb, headDb, {
      base: { ref: base.ref, commit: base.commit },
      head: head ? { ref: head.ref, commit: head.commit } : null,
    });
  } finally {
    baseDb.close();
    headDb.close();
  }
}
