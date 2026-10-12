import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { getMetaJson, type Db } from "../db/database.js";
import type { FindingRow } from "../db/writer.js";
import { baseName, dirOf, joinPosix } from "../resolve/path-utils.js";

/** 比随机碰上高出这么多倍才算「总是一起改」：天天在改的大文件和谁都一起改 */
const MIN_LIFT = 2;
/** co_changes 收到 3 次就记（文件详情里「常一起改的文件」用），报成问题要更多次 */
const MIN_TOGETHER = 4;
const MAX_COUPLINGS = 30;

/**
 * 隐藏的耦合：git 历史里总是一起改，代码里却没有依赖关系（直接 import，或者经过同一个
 * 文件间接相连都不算）。改一处就得改另一处，而静态图上它们毫无关系——这正是 AI 改代码
 * 时最容易漏掉的地方：它只改了眼前那个文件。
 *
 * 只看源码到源码；天天在改的枢纽文件（词典、路由表）和谁都一起改，用提升度把它们排除。
 */
export function detectCoupling(db: Db, out: FindingRow[]): number {
  const history = getMetaJson<{ commits: number } | null>(db, "history", null);
  if (!history || history.commits === 0) return 0;
  const pairs = db.prepare(
    `SELECT c.a, c.b, c.together, ha.commits AS ca, hb.commits AS cb, fa.id AS aId, fb.id AS bId
     FROM co_changes c
     JOIN file_history ha ON ha.path = c.a JOIN file_history hb ON hb.path = c.b
     JOIN files fa ON fa.path = c.a AND fa.role = 'source' JOIN files fb ON fb.path = c.b AND fb.role = 'source'`,
  ).all() as Array<{ a: string; b: string; together: number; ca: number; cb: number; aId: number; bId: number }>;
  if (pairs.length === 0) return 0;

  const neighbors = new Map<number, Set<number>>();
  const link = (x: number, y: number) => {
    const set = neighbors.get(x);
    if (set) set.add(y); else neighbors.set(x, new Set([y]));
  };
  for (const edge of db.prepare(
    `SELECT src_id AS src, dst_id AS dst FROM edges
     WHERE src_kind = 'file' AND dst_kind = 'file' AND type IN ('imports', 'references', 'http')`,
  ).all() as Array<{ src: number; dst: number }>) {
    link(edge.src, edge.dst);
    link(edge.dst, edge.src);
  }
  const related = (a: number, b: number) => {
    const na = neighbors.get(a);
    const nb = neighbors.get(b);
    if (!na || !nb) return false;
    if (na.has(b)) return true;
    for (const x of na) if (nb.has(x)) return true;
    return false;
  };

  const hidden = pairs
    .map((pair) => ({ ...pair, lift: (pair.together * history.commits) / Math.max(1, pair.ca * pair.cb) }))
    .filter((pair) => pair.together >= MIN_TOGETHER && pair.lift >= MIN_LIFT && !related(pair.aId, pair.bId))
    .sort((x, y) => y.together - x.together || y.lift - x.lift)
    .slice(0, MAX_COUPLINGS);

  for (const pair of hidden) {
    const title = `${baseName(pair.a)} 和 ${baseName(pair.b)} 总是一起改，代码里却没有依赖`;
    const detail = [
      `近一年有 ${pair.together} 次提交同时改了这两个文件（各自改过 ${pair.ca} / ${pair.cb} 次）：`,
      pair.a,
      pair.b,
      "两者之间没有 import 关系，也不经过同一个文件相连。这种耦合在依赖图上看不见：改一处时多半也得改另一处，",
      "通常意味着两边各自写了一份同样的约定（格式、协议、配置键），可以考虑抽到一处。",
    ].join("\n");
    for (const [id, path] of [[pair.aId, pair.a], [pair.bId, pair.b]] as const) {
      out.push({
        kind: "coupling",
        severity: "low",
        scopeKind: "file",
        scopeKey: `file:${id}`,
        path,
        title,
        detail,
        related: [`file:${pair.aId}`, `file:${pair.bId}`],
        groupKey: `coupling:${pair.a}\u0000${pair.b}`,
      });
    }
  }
  return hidden.length;
}

const PATH_TOKEN = /^(?!\/|~|[a-z]+:)[\w@.-]+(?:\/[\w@.-]+)+\.[A-Za-z0-9]{1,8}$/;
const SKIP_PARTS = /(?:^|\/)(?:node_modules|dist|build|out|coverage|target|\.repolens|\.git|vendor)\//;
const CODE_SPAN = /`([^`\n]+)`/g;
const LINK = /\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const MAX_DOC_BYTES = 512 * 1024;

/**
 * 文档里引用的仓库路径已经不存在。README、设计文档是作者写下的意图，代码挪走、改名、
 * 删掉之后文档还指着旧路径，读的人就会被带到不存在的地方——「说的」和「做的」开始分家。
 *
 * 两种引用分开判：相对链接 `[x](docs/a.md)` 是明确的跳转，指不到就是坏链接；反引号里的
 * 路径常是举例或别的仓库里的文件，只有 git 历史证明它在这个仓库里存在过、后来被删或改名了
 * 才算过期。只要仓库里还有任何一个文件以它结尾就算存在，宁可漏报。外链、绝对路径、通配符、
 * 构建产物目录一律不看。
 */
export function detectStaleDocs(db: Db, root: string, out: FindingRow[]): number {
  const docs = db.prepare(
    "SELECT id, path FROM files WHERE role = 'docs' AND (path LIKE '%.md' OR path LIKE '%.mdx' OR path LIKE '%.markdown')",
  ).all() as Array<{ id: number; path: string }>;
  if (docs.length === 0) return 0;
  const indexed = (db.prepare("SELECT path FROM files").all() as Array<{ path: string }>).map((row) => row.path);
  const known = new Set(indexed);
  const suffixes = new Set<string>();
  for (const path of indexed) {
    const parts = path.split("/");
    for (let i = 1; i < parts.length; i++) suffixes.add(parts.slice(i).join("/"));
  }
  const exists = (docDir: string, ref: string): boolean => {
    if (known.has(ref) || suffixes.has(ref)) return true;
    for (const candidate of [joinPosix(docDir, ref), ref]) {
      if (candidate.startsWith("..")) continue;
      if (known.has(candidate) || existsSync(join(root, ...candidate.split("/")))) return true;
    }
    return false;
  };

  let deleted: Set<string> | null = null;
  const wasDeleted = (ref: string): boolean => {
    deleted ??= deletedPaths(root);
    if (deleted.has(ref)) return true;
    for (const path of deleted) if (path.endsWith(`/${ref}`)) return true;
    return false;
  };

  let count = 0;
  for (const doc of docs) {
    let text: string;
    try {
      if (statSync(join(root, doc.path)).size > MAX_DOC_BYTES) continue;
      text = readFileSync(join(root, doc.path), "utf8");
    } catch {
      continue;
    }
    const docDir = dirOf(doc.path);
    const missing = new Map<string, number>();
    const consider = (raw: string, index: number, link: boolean) => {
      const ref = raw.replace(/^\.\//, "").replace(/[#?].*$/, "").replace(/:\d+(?:-\d+)?$/, "");
      if (!PATH_TOKEN.test(ref) || SKIP_PARTS.test(`${ref}/`) || /[*{}<>$]/.test(ref) || missing.has(ref)) return;
      if (exists(docDir, ref) || (!link && !wasDeleted(ref))) return;
      missing.set(ref, text.slice(0, index).split("\n").length);
    };
    for (const match of text.matchAll(CODE_SPAN)) consider(match[1]!.trim(), match.index ?? 0, false);
    for (const match of text.matchAll(LINK)) {
      const target = match[1]!;
      if (!/^(?:https?:|mailto:|#)/i.test(target)) consider(target, match.index ?? 0, true);
    }
    if (missing.size === 0) continue;
    count++;
    const refs = [...missing].slice(0, 12);
    out.push({
      kind: "stale-doc",
      severity: "low",
      scopeKind: "file",
      scopeKey: `file:${doc.id}`,
      path: doc.path,
      title: `文档里引用了 ${missing.size} 个已经不存在的路径`,
      detail: [
        "这些路径在仓库里找不到了：多半是代码挪过、改过名或删掉了，文档没跟着改。",
        ...refs.map(([ref, line]) => `L${line}  ${ref}`),
        ...(missing.size > refs.length ? [`…另有 ${missing.size - refs.length} 处`] : []),
      ].join("\n"),
      related: [`file:${doc.id}`],
      groupKey: `stale-doc:${doc.path}`,
    });
  }
  return count;
}

/** git 历史里被删掉（含改名前的旧名）的路径；不在 git 里时为空 */
function deletedPaths(root: string): Set<string> {
  try {
    const raw = execFileSync(
      "git",
      [
        "--no-pager", "-C", root, "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
        "log", "--relative", "--no-renames", "--diff-filter=D", "--name-only", "--format=", "-n20000",
      ],
      { encoding: "utf8", maxBuffer: 128 * 1024 * 1024, timeout: 20_000, stdio: ["ignore", "pipe", "ignore"] },
    );
    return new Set(raw.split("\n").map((line) => line.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}
