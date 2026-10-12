import type { FileHistoryDto } from "../types.js";
import type { Db } from "./database.js";
import { inBatches } from "./scope.js";

const CO_CHANGED_LISTED = 8;

export interface CommitCounts {
  commits: number;
  /** 近 90 天 */
  recent: number;
  ai: number;
}

/**
 * 一组文件的提交数，按提交去重：一次提交改了模块里五个文件也只算一次。
 * 没读过历史时为 null。
 */
export function commitCounts(db: Db, fileIds: Iterable<number>): CommitCounts | null {
  const ids = [...fileIds];
  if (ids.length === 0) return null;
  const commits = new Set(inBatches(ids, (batch) => db.prepare(
    `SELECT DISTINCT h.commit_id AS id FROM history_files h JOIN files f ON f.path = h.path
     WHERE f.id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ id: number }>).map((row) => row.id));
  if (commits.size === 0) return null;
  const flags = inBatches([...commits], (batch) => db.prepare(
    `SELECT recent, ai FROM history_commits WHERE id IN (${batch.map(() => "?").join(",")})`,
  ).all(...batch) as Array<{ recent: number; ai: number }>);
  return {
    commits: commits.size,
    recent: flags.reduce((sum, row) => sum + row.recent, 0),
    ai: flags.reduce((sum, row) => sum + row.ai, 0),
  };
}

/** 一个文件的 git 历史，以及常和它一起改的文件。没读过历史（不在 git 里、配置关掉）时为 null */
export function fileHistory(db: Db, fileId: number): FileHistoryDto | null {
  const file = db.prepare("SELECT path FROM files WHERE id = ?").get(fileId) as { path: string } | undefined;
  if (!file) return null;
  const row = db.prepare(
    "SELECT commits, recent, last_at AS lastAt, authors, ai_commits AS ai FROM file_history WHERE path = ?",
  ).get(file.path) as { commits: number; recent: number; lastAt: string | null; authors: number; ai: number } | undefined;
  if (!row) return null;

  const partners = db.prepare(
    `SELECT CASE WHEN a = ? THEN b ELSE a END AS path, together FROM co_changes
     WHERE a = ? OR b = ? ORDER BY together DESC LIMIT ?`,
  ).all(file.path, file.path, file.path, CO_CHANGED_LISTED) as Array<{ path: string; together: number }>;
  const idOf = db.prepare("SELECT id FROM files WHERE path = ?");
  const neighbors = (id: number) => new Set((db.prepare(
    `SELECT dst_id AS other FROM edges WHERE src_kind = 'file' AND dst_kind = 'file' AND type IN ('imports', 'references', 'http') AND src_id = ?
     UNION SELECT src_id AS other FROM edges WHERE src_kind = 'file' AND dst_kind = 'file' AND type IN ('imports', 'references', 'http') AND dst_id = ?`,
  ).all(id, id) as Array<{ other: number }>).map((r) => r.other));
  const mine = neighbors(fileId);

  return {
    commits: row.commits,
    recentCommits: row.recent,
    lastChangedAt: row.lastAt,
    authors: row.authors,
    aiCommits: row.ai,
    coChanged: partners.map((partner) => {
      const id = (idOf.get(partner.path) as { id: number } | undefined)?.id ?? null;
      const theirs = id === null ? new Set<number>() : neighbors(id);
      // 直接依赖，或者经过同一个文件相连，都算代码里有关系
      const linked = id !== null && (mine.has(id) || [...mine].some((x) => theirs.has(x)));
      return { id: id === null ? null : `file:${id}`, path: partner.path, together: partner.together, linked };
    }),
  };
}
