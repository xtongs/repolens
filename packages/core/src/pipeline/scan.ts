import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "../config.js";
import { indexPath, openDb, setMeta, setMetaJson, transact, type Db } from "../db/database.js";
import { IndexWriter, type CallSiteRow, type ImportRow, type TypeRelationRow } from "../db/writer.js";
import { isAnalyzable } from "../discovery/language.js";
import { hashContent, walkRepo } from "../discovery/walk.js";
import { discoverPackages } from "../discovery/workspace.js";
import { attachShapes } from "../parse/ast-utils.js";
import { extractorFor } from "../parse/extractors/registry.js";
import { ParserPool } from "../parse/parser-pool.js";
import { ancestorDirs, baseName, dirOf } from "../resolve/path-utils.js";
import { createResolvers } from "../resolve/registry.js";
import { enrichRepository } from "../llm/enrich.js";
import type {
  Confidence,
  DiscoveredFile,
  DiscoveredPackage,
  ParsedFile,
  ResolveContext,
  ScanPhase,
  ScanStats,
} from "../types.js";
import { linkGraph } from "./link.js";
import { countLoc } from "./metrics.js";

export type { ScanPhase } from "../types.js";

export interface ScanOptions {
  root: string;
  /** 忽略已有索引，全量重建 */
  fresh?: boolean;
  onProgress?: (phase: ScanPhase, done: number, total: number) => void;
}

interface PreviousFile {
  id: number;
  hash: string;
  parsed: number;
  /** 角色和语言由配置决定，改了配置就算内容没变也要重新入库 */
  role: string;
  language: string;
}

/**
 * 扫描编排。
 *
 * 阶段划分见 docs/ARCHITECTURE.md#解析流水线。这里的关键约束是
 * 「文件全部入库」必须早于「import 解析」——解析结果要落成 target_file_id，
 * 而拿到 id 的前提是目标文件已经有记录。
 */
export async function scanRepo(options: ScanOptions): Promise<ScanStats> {
  const started = Date.now();
  const { root } = options;
  const report = options.onProgress ?? (() => {});

  const config = loadConfig(root);

  report("discover", 0, 1);
  const packages = discoverPackages(root);
  const walked = walkRepo(root, config, packages);
  report("discover", 1, 1);

  const db = openDb(indexPath(root), { fresh: options.fresh ?? false });
  const writer = new IndexWriter(db);

  const stats = emptyStats();
  stats.filesDiscovered = walked.files.length;
  stats.packages = packages.length;

  const previous = loadPreviousFiles(db);
  const discoveredPaths = new Set(walked.files.map((f) => f.path));

  const fileIdByPath = transact(db, () => {
    const { byDir: packageIdByDir, changed: packagesChanged } = writer.syncPackages(packages);
    writer.syncDirectories(collectDirectories(walked.files, walked.directories), packageIdByDir);

    for (const path of previous.keys()) {
      if (!discoveredPaths.has(path)) {
        writer.deleteFile(path);
        stats.filesDeleted++;
      }
    }

    const ids = new Map<string, number>();
    for (const file of walked.files) {
      const prev = previous.get(file.path);
      // 只比内容和分类：解析状态是否过期由下面的 toParse 单独判断。
      // 把 parsed 混进来会让所有无需解析的文件（md/json/资源）每次
      // 扫描都被重读一遍，纯属浪费。
      if (
        prev &&
        prev.hash === file.hash &&
        prev.role === file.role &&
        prev.language === file.language
      ) {
        ids.set(file.path, prev.id);
        continue;
      }
      const loc = file.role === "asset" ? 0 : countLoc(readText(root, file.path), file.language);
      ids.set(
        file.path,
        writer.upsertFile(
          {
            path: file.path,
            language: file.language,
            role: file.role,
            bytes: file.bytes,
            hash: file.hash,
            loc,
            packageDir: file.packageDir,
          },
          packageIdByDir,
        ),
      );
    }

    // 新增或移除包会改变一批既有文件的归属，而这些文件内容没变、
    // 不会走上面的 upsert，只能整体对账一次
    if (packagesChanged) writer.reassignFilePackages();

    return ids;
  });

  const toParse = walked.files.filter((file) => {
    if (!isAnalyzable(file.language)) return false;
    if (file.role === "asset" || file.role === "vendor") return false;
    const prev = previous.get(file.path);
    return !(prev && prev.hash === file.hash && prev.parsed === 1);
  });

  stats.filesReused = walked.files.length - toParse.length;

  const pool = new ParserPool();
  const resolvers = createResolvers();
  const resolveCtx = buildResolveContext(root, discoveredPaths, walked.directories, packages);

  let done = 0;
  report("parse", 0, toParse.length);

  // 逐文件解析并立即入库。批量攒在内存里再一次性写虽然更快，
  // 但 1400 文件的 AST 产物会吃掉几百 MB，不值得。
  for (const file of toParse) {
    const fileId = fileIdByPath.get(file.path);
    if (fileId === undefined) continue;

    const source = readText(root, file.path);
    const parsed = await parseFile(pool, file, source);

    transact(db, () => {
      writer.clearFileArtifacts(fileId);
      if (parsed === null) {
        writer.markParsed(fileId, 0, "该语言的 tree-sitter 语法不可用");
        return;
      }
      persistParsed(writer, resolvers, resolveCtx, fileIdByPath, fileId, file, source, parsed, stats);
    });

    done++;
    if (done % 25 === 0 || done === toParse.length) report("parse", done, toParse.length);
  }

  pool.dispose();
  stats.filesParsed = toParse.length;

  report("link", 0, 1);
  const linkStats = transact(db, () => linkGraph(db, writer));
  stats.calls = linkStats.calls;
  stats.callsByConfidence = linkStats.callsByConfidence;
  report("link", 1, 1);

  report("rollup", 0, 1);
  transact(db, () => writer.rollupDirectoryMetrics());
  report("rollup", 1, 1);

  // 先把结构元数据落稳，再尝试语义增强。模型故障只能影响 M3，绝不能让
  // 已成功的结构扫描失败或丢失。
  setMeta(db, "repo_root", root);
  setMeta(db, "repo_name", baseName(root) === "." ? "repo" : baseName(root));
  setMeta(db, "scanned_at", new Date().toISOString());

  report("enrich", 0, 1);
  try {
    stats.llm = await enrichRepository(db, root, config.llm);
  } catch (err) {
    stats.llm = {
      enabled: config.llm.enabled,
      available: false,
      model: config.llm.model,
      generated: 0,
      cacheHits: 0,
      failures: 1,
      durationMs: 0,
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      reason: (err as Error).message,
    };
  }
  report("enrich", 1, 1);

  report("index", 0, 1);
  transact(db, () => {
    const totals = db
      .prepare(
        `SELECT COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc FROM files WHERE role != 'asset'`,
      )
      .get() as { files: number; loc: number };
    stats.loc = totals.loc;
    stats.symbols = (db.prepare("SELECT COUNT(*) AS n FROM symbols").get() as { n: number }).n;
    stats.byLanguage = languageBreakdown(db);
    stats.durationMs = Date.now() - started;

    setMetaJson(db, "stats", stats);
  });
  report("index", 1, 1);

  db.close();
  return stats;
}

// ---------------------------------------------------------------------------
// 解析与入库
// ---------------------------------------------------------------------------

async function parseFile(
  pool: ParserPool,
  file: DiscoveredFile,
  source: string,
): Promise<ParsedFile | null> {
  if (!isAnalyzable(file.language)) return null;
  const parser = await pool.parserFor(file.language);
  if (!parser) return null;

  const tree = parser.parse(source);
  if (!tree) return null;

  try {
    const parsed = extractorFor(file.language).extract({
      root: tree.rootNode,
      source,
      language: file.language,
      path: file.path,
    });
    // 形状指纹在这里统一算，而不是散到四个抽取器里去——它只依赖 AST，
    // 和语言无关，而这里是唯一同时握有语法树和符号表的地方。
    attachShapes(tree.rootNode, parsed.symbols);
    return parsed;
  } catch (err) {
    // 单个文件的抽取失败不该中断整次扫描，把错误留在 files.parse_error 里
    return {
      symbols: [],
      imports: [],
      exports: [],
      calls: [],
      typeRelations: [],
      hasError: true,
      moduleDecls: [`抽取失败：${(err as Error).message}`],
    };
  } finally {
    tree.delete();
  }
}

function persistParsed(
  writer: IndexWriter,
  resolvers: ReturnType<typeof createResolvers>,
  baseCtx: Omit<ResolveContext, "fromFile">,
  fileIdByPath: ReadonlyMap<string, number>,
  fileId: number,
  file: DiscoveredFile,
  source: string,
  parsed: ParsedFile,
  stats: ScanStats,
): void {
  const symbolHashes = parsed.symbols.map((sym) =>
    hashContent(source.slice(sym.startByte, sym.endByte)),
  );
  const symbolIds = writer.insertSymbols(fileId, parsed.symbols, symbolHashes);

  // 调用者必须按「容器 + 名字」定位。只按名字查的话，一个文件里两个类
  // 各有一个 handleInput 时，两边的调用会全部记到先声明的那个头上——
  // 表现为某个三行的小方法在调用图上有上百条出边。
  const symbolIdByKey = new Map<string, number>();
  // 导出和类型声明都在顶层，用单独的映射避免被同名的方法抢走
  const topLevelIdByName = new Map<string, number>();
  for (const [i, sym] of parsed.symbols.entries()) {
    const id = symbolIds[i];
    if (id === undefined) continue;
    const key = symbolKey(sym.container ?? null, sym.name);
    if (!symbolIdByKey.has(key)) symbolIdByKey.set(key, id);
    if (sym.container == null && !topLevelIdByName.has(sym.name)) {
      topLevelIdByName.set(sym.name, id);
    }
  }

  writer.insertExports(fileId, parsed.exports, topLevelIdByName);

  const resolver = isAnalyzable(file.language) ? resolvers.get(file.language) : undefined;
  const importRows: ImportRow[] = [];

  for (const imp of parsed.imports) {
    stats.imports++;
    const outcome = resolver
      ? resolver.resolve(imp.source, { ...baseCtx, fromFile: file.path })
      : ({ status: "unresolved", reason: "该语言没有模块解析器" } as const);

    let confidence: Confidence;
    let targetFileId: number | null = null;
    let targetDir: string | null = null;
    let externalName: string | null = null;
    let unresolvedReason: string | null = null;

    switch (outcome.status) {
      case "internal":
        confidence = "exact";
        targetFileId = fileIdByPath.get(outcome.target) ?? null;
        if (targetFileId === null) {
          confidence = "unresolved";
          unresolvedReason = `目标文件未入库：${outcome.target}`;
          stats.importsUnresolved++;
        } else {
          stats.importsResolved++;
        }
        break;
      case "internal-dir":
        confidence = "exact";
        targetDir = outcome.target;
        stats.importsResolved++;
        break;
      case "external":
        confidence = "external";
        externalName = outcome.name;
        stats.importsExternal++;
        break;
      case "unresolved":
        confidence = "unresolved";
        unresolvedReason = outcome.reason;
        stats.importsUnresolved++;
        break;
    }

    importRows.push({
      rawSource: imp.source,
      kind: imp.kind,
      confidence,
      targetFileId,
      targetDir,
      externalName,
      unresolvedReason,
      isTypeOnly: imp.isTypeOnly ?? false,
      line: imp.line,
      specifiers: imp.specifiers.map((s) => ({
        imported: s.imported,
        local: s.local,
        isDefault: s.isDefault ?? false,
        isNamespace: s.isNamespace ?? false,
      })),
    });
  }

  writer.insertImports(fileId, importRows);

  const callSites: CallSiteRow[] = parsed.calls.map((call) => ({
    callerSymbolId:
      call.callerName !== null
        ? (symbolIdByKey.get(symbolKey(call.callerContainer ?? null, call.callerName)) ?? null)
        : null,
    calleeName: call.callee,
    receiver: call.receiver ?? null,
    calleePath: call.calleePath ? call.calleePath.join(".") : null,
    callKind: call.kind,
    argCount: call.argCount,
    argumentTexts: call.argumentTexts ?? [],
    line: call.line,
  }));
  writer.insertCallSites(fileId, callSites);
  writer.insertEntryHints(fileId, parsed.entryHints ?? []);

  const typeRelations: TypeRelationRow[] = parsed.typeRelations.map((rel) => ({
    subjectId: topLevelIdByName.get(rel.subject) ?? null,
    subject: rel.subject,
    relation: rel.relation,
    target: rel.target,
    targetId: null, // 跨文件类型链接在 link 阶段统一处理
    confidence: "unresolved",
    line: rel.line,
  }));
  writer.insertTypeRelations(fileId, typeRelations);

  const fileComplexity = parsed.symbols.reduce((sum, s) => sum + s.complexity, 0);
  if (parsed.hasError) stats.parseErrors++;
  writer.markParsed(fileId, fileComplexity, parsed.hasError ? "存在语法错误节点" : null);
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/** 符号在文件内的唯一键。顶层符号直接用名字，成员用容器隔开。 */
function symbolKey(container: string | null, name: string): string {
  return container === null ? name : `${container}\u0000${name}`;
}

function buildResolveContext(
  root: string,
  files: ReadonlySet<string>,
  directories: readonly string[],
  packages: readonly DiscoveredPackage[],
): Omit<ResolveContext, "fromFile"> {
  const dirSet = new Set(directories);
  dirSet.add(".");
  return {
    root,
    hasFile: (p) => files.has(p),
    hasDir: (p) => dirSet.has(p),
    packages,
  };
}

function collectDirectories(
  files: readonly DiscoveredFile[],
  walkedDirs: readonly string[],
): string[] {
  const dirs = new Set(walkedDirs);
  // 走目录得到的集合可能漏掉只在路径里出现过的层级，用文件路径补齐
  for (const file of files) {
    for (const dir of ancestorDirs(file.path)) dirs.add(dir);
    const parent = dirOf(file.path);
    if (parent !== ".") dirs.add(parent);
  }
  dirs.delete(".");
  return [...dirs];
}

function loadPreviousFiles(db: Db): Map<string, PreviousFile> {
  const rows = db.prepare("SELECT id, path, hash, parsed, role, language FROM files").all() as Array<{
    id: number;
    path: string;
    hash: string;
    parsed: number;
    role: string;
    language: string;
  }>;
  return new Map(
    rows.map((r) => [
      r.path,
      { id: r.id, hash: r.hash, parsed: r.parsed, role: r.role, language: r.language },
    ]),
  );
}

function languageBreakdown(db: Db): ScanStats["byLanguage"] {
  const rows = db
    .prepare(
      `SELECT language, COUNT(*) AS files, COALESCE(SUM(loc), 0) AS loc
       FROM files WHERE role != 'asset' GROUP BY language`,
    )
    .all() as Array<{ language: string; files: number; loc: number }>;
  const out: ScanStats["byLanguage"] = {};
  for (const row of rows) out[row.language] = { files: row.files, loc: row.loc };
  return out;
}

function readText(root: string, relPath: string): string {
  try {
    return readFileSync(join(root, relPath), "utf8");
  } catch {
    return "";
  }
}

function emptyStats(): ScanStats {
  return {
    durationMs: 0,
    filesDiscovered: 0,
    filesParsed: 0,
    filesReused: 0,
    filesDeleted: 0,
    symbols: 0,
    imports: 0,
    importsResolved: 0,
    importsExternal: 0,
    importsUnresolved: 0,
    calls: 0,
    callsByConfidence: {
      exact: 0,
      likely: 0,
      ambiguous: 0,
      external: 0,
      unresolved: 0,
    },
    parseErrors: 0,
    packages: 0,
    loc: 0,
    byLanguage: {},
  };
}
