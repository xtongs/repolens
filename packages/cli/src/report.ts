import type { OverviewDto, ScanStats } from "@repolens/core";

const BAR_WIDTH = 24;

export function progressBar(done: number, total: number): string {
  if (total <= 0) return "[" + "─".repeat(BAR_WIDTH) + "]";
  const filled = Math.round((done / total) * BAR_WIDTH);
  return `[${"█".repeat(filled)}${"─".repeat(BAR_WIDTH - filled)}]`;
}

export function formatScanReport(root: string, stats: ScanStats): string {
  const lines: string[] = [];
  lines.push(`已索引 ${root}`);
  lines.push("");
  lines.push(
    row("文件", `${stats.filesDiscovered} 个（解析 ${stats.filesParsed}，复用 ${stats.filesReused}，删除 ${stats.filesDeleted}）`),
  );
  lines.push(row("代码行", `${formatNumber(stats.loc)}`));
  lines.push(row("符号", `${formatNumber(stats.symbols)}`));
  lines.push(row("包", `${stats.packages}`));
  lines.push(
    row(
      "依赖",
      `${stats.imports} 条 import：内部 ${stats.importsResolved}，外部 ${stats.importsExternal}，未解析 ${stats.importsUnresolved}${resolutionRate(stats)}`,
    ),
  );
  lines.push(row("调用点", `${formatNumber(stats.calls)}${callBreakdown(stats)}`));
  if (stats.parseErrors > 0) {
    lines.push(row("语法警告", `${stats.parseErrors} 个文件含无法解析的节点`));
  }

  const langs = Object.entries(stats.byLanguage)
    .filter(([, v]) => v.loc > 0)
    .sort((a, b) => b[1].loc - a[1].loc)
    .slice(0, 6)
    .map(([lang, v]) => `${lang} ${formatNumber(v.loc)}`)
    .join(" · ");
  if (langs.length > 0) lines.push(row("语言", langs));

  lines.push(row("耗时", `${(stats.durationMs / 1000).toFixed(2)}s`));
  lines.push("");
  lines.push("运行 `repolens serve` 在浏览器中查看，或 `repolens open` 一步到位。");
  lines.push("");
  return lines.join("\n");
}

export function formatOverview(overview: OverviewDto): string {
  const lines: string[] = [];
  lines.push(`${overview.repoName}  ${overview.repoRoot}`);
  lines.push(`扫描于 ${overview.scannedAt}`);
  lines.push("");
  lines.push(row("文件", formatNumber(overview.totals.files)));
  lines.push(row("代码行", formatNumber(overview.totals.loc)));
  lines.push(row("符号", formatNumber(overview.totals.symbols)));
  lines.push(row("调用点", formatNumber(overview.totals.calls)));
  lines.push(
    row(
      "依赖",
      `${formatNumber(overview.totals.imports)} 条 import：内部 ${formatNumber(
        overview.totals.importsResolved,
      )}，外部 ${formatNumber(overview.totals.importsExternal)}，未解析 ${formatNumber(
        overview.totals.importsUnresolved,
      )}`,
    ),
  );

  if (overview.languages.length > 0) {
    lines.push("");
    lines.push("语言构成");
    for (const lang of overview.languages.slice(0, 8)) {
      const pct = (lang.share * 100).toFixed(1).padStart(5, " ");
      lines.push(`  ${lang.language.padEnd(12, " ")} ${pct}%  ${formatNumber(lang.loc)} 行`);
    }
  }

  if (overview.packages.length > 1) {
    lines.push("");
    lines.push("包");
    for (const pkg of overview.packages.slice(0, 20)) {
      lines.push(`  ${pkg.name.padEnd(28, " ")} ${formatNumber(pkg.loc).padStart(8, " ")} 行  ${pkg.dir}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * 调用点的置信度构成。
 *
 * 这个数字比总数有用得多：调用图上默认只画 exact 和 likely，
 * 报出构成才能让人知道自己看到的是全部调用里的哪一部分。
 */
function callBreakdown(stats: ScanStats): string {
  const by = stats.callsByConfidence;
  if (!by || stats.calls === 0) return "";
  const certain = (by.exact ?? 0) + (by.likely ?? 0);
  return `（确定 ${formatNumber(by.exact ?? 0)}，可能 ${formatNumber(
    by.likely ?? 0,
  )}，多义 ${formatNumber(by.ambiguous ?? 0)}，外部 ${formatNumber(
    by.external ?? 0,
  )}，未解析 ${formatNumber(by.unresolved ?? 0)}；可画出 ${(
    (certain / stats.calls) *
    100
  ).toFixed(1)}%）`;
}

function resolutionRate(stats: ScanStats): string {
  const internalOrExternal = stats.importsResolved + stats.importsExternal;
  const total = internalOrExternal + stats.importsUnresolved;
  if (total === 0) return "";
  return `，解析率 ${((internalOrExternal / total) * 100).toFixed(1)}%`;
}

function row(label: string, value: string): string {
  return `  ${label.padEnd(8, " ")} ${value}`;
}

function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
