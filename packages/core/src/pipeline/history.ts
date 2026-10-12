import { execFileSync } from "node:child_process";
import type { Db } from "../db/database.js";

export interface HistoryStats {
  commits: number;
  files: number;
  aiCommits: number;
}

const HISTORY_SINCE = "12 months ago";
const MAX_COMMITS = 5000;
const RECENT_MS = 90 * 24 * 3600 * 1000;
/** 一次动了太多文件的提交多是批量格式化、改名或依赖升级，算进协同变更只会把所有文件连成一团 */
const MAX_FILES_PER_COMMIT = 30;
/** 至少一起改过这么多次，而且占两者中改得少的那个的一半以上，才算「总是一起改」 */
const MIN_TOGETHER = 3;
const MIN_SHARE = 0.5;
const MAX_PAIRS = 2000;
const GIT_TIMEOUT_MS = 20_000;

/** Co-authored-by 里出现这些名字，或者提交说明里标着由它们生成的，算 AI 参与 */
const AI_AGENT = /\b(claude|anthropic|cursor|copilot|openai|codex|chatgpt|gpt-?\d|gemini|aider|devin|windsurf|codeium|cody|kiro|trae|jules|qwen|deepseek)\b/i;
const AI_TRAILER = /^co-authored-by:\s*(.+)$/gim;
const AI_GENERATED = /generated (?:with|by)\s*\[?([^\]\n]+)|🤖/i;

/**
 * 读 git 历史：每个文件近一年和近 90 天改过几次、几个人改、多少次有 AI 参与，以及总是一起改的文件对。
 *
 * 这些都是事实，不是推断：改得勤的复杂代码就是读代码时最该慢下来的地方，而总是一起改、
 * 代码里却没有依赖的文件，是静态图上看不见的关节。不在 git 里、git 不可用时安静地跳过。
 */
export function collectHistory(db: Db, root: string): HistoryStats | null {
  let raw: string;
  try {
    raw = execFileSync(
      "git",
      [
        "--no-pager", "-C", root, "-c", "core.fsmonitor=false", "-c", "core.quotepath=false",
        "log", "--relative", "--no-merges", "--no-renames", "--name-only", `--since=${HISTORY_SINCE}`, `-n${MAX_COMMITS}`,
        "--format=%x1e%H%x1f%aN%x1f%cI%x1f%B%x1d",
      ],
      {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        timeout: GIT_TIMEOUT_MS,
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
      },
    );
  } catch {
    return null;
  }

  const indexed = new Map(
    (db.prepare("SELECT path, role FROM files").all() as Array<{ path: string; role: string }>).map((row) => [row.path, row.role]),
  );
  const perFile = new Map<string, { commits: number; recent: number; last: string | null; authors: Set<string>; ai: number }>();
  const perCommit: Array<{ recent: boolean; ai: boolean; files: string[] }> = [];
  const pairs = new Map<string, number>();
  const now = Date.now();
  let commits = 0;
  let aiCommits = 0;

  for (const record of raw.split("\x1e")) {
    const end = record.indexOf("\x1d");
    if (end < 0) continue;
    const [hash = "", author = "", date = "", body = ""] = record.slice(0, end).split("\x1f");
    if (hash === "") continue;
    const files = [...new Set(record.slice(end + 1).split("\n").map((line) => line.trim()).filter((path) => indexed.has(path)))];
    if (files.length === 0) continue;
    commits++;
    const ai = isAiAssisted(body);
    if (ai) aiCommits++;
    const recent = now - Date.parse(date) <= RECENT_MS;
    perCommit.push({ recent, ai, files });

    for (const path of files) {
      let stats = perFile.get(path);
      if (!stats) {
        stats = { commits: 0, recent: 0, last: null, authors: new Set(), ai: 0 };
        perFile.set(path, stats);
      }
      stats.commits++;
      if (recent) stats.recent++;
      // git log 新的在前，第一次见到的就是最近一次
      stats.last ??= date;
      stats.authors.add(author);
      if (ai) stats.ai++;
    }

    const sources = files.filter((path) => indexed.get(path) === "source").sort();
    if (sources.length < 2 || sources.length > MAX_FILES_PER_COMMIT) continue;
    for (let i = 0; i < sources.length; i++) {
      for (let j = i + 1; j < sources.length; j++) {
        const key = `${sources[i]}\u0000${sources[j]}`;
        pairs.set(key, (pairs.get(key) ?? 0) + 1);
      }
    }
  }

  clearHistory(db);
  const insertFile = db.prepare(
    "INSERT INTO file_history (path, commits, recent, last_at, authors, ai_commits) VALUES (?, ?, ?, ?, ?, ?)",
  );
  for (const [path, stats] of perFile) {
    insertFile.run(path, stats.commits, stats.recent, stats.last, stats.authors.size, stats.ai);
  }
  const insertCommit = db.prepare("INSERT INTO history_commits (recent, ai) VALUES (?, ?)");
  const insertCommitFile = db.prepare("INSERT INTO history_files (commit_id, path) VALUES (?, ?)");
  for (const commit of perCommit) {
    const id = Number(insertCommit.run(commit.recent ? 1 : 0, commit.ai ? 1 : 0).lastInsertRowid);
    for (const path of commit.files) insertCommitFile.run(id, path);
  }

  const strong = [...pairs]
    .map(([key, together]) => {
      const [a = "", b = ""] = key.split("\u0000");
      const fewer = Math.min(perFile.get(a)?.commits ?? 0, perFile.get(b)?.commits ?? 0);
      return { a, b, together, share: fewer > 0 ? together / fewer : 0 };
    })
    .filter((pair) => pair.together >= MIN_TOGETHER && pair.share >= MIN_SHARE)
    .sort((x, y) => y.together - x.together || y.share - x.share)
    .slice(0, MAX_PAIRS);
  const insertPair = db.prepare("INSERT INTO co_changes (a, b, together) VALUES (?, ?, ?)");
  for (const pair of strong) insertPair.run(pair.a, pair.b, pair.together);

  return { commits, files: perFile.size, aiCommits };
}

export function clearHistory(db: Db): void {
  db.exec("DELETE FROM file_history; DELETE FROM co_changes; DELETE FROM history_files; DELETE FROM history_commits");
}

export function isAiAssisted(body: string): boolean {
  for (const match of body.matchAll(AI_TRAILER)) {
    if (AI_AGENT.test(match[1] ?? "")) return true;
  }
  const generated = AI_GENERATED.exec(body);
  return generated !== null && (generated[0] === "🤖" || AI_AGENT.test(generated[1] ?? ""));
}
