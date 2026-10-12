import { loadConfig, updateTeamConfig } from "./config.js";
import { getMeta, type Db } from "./db/database.js";
import { confirmedLayers, ROOT_SCOPE } from "./db/queries.js";
import { getSkeleton } from "./db/skeleton.js";
import type { TourDto, TourStepDto } from "./types.js";

export const GENERATED_TOUR_ID = "auto";
const MAX_STEPS = 18;

export class TourInputError extends Error {}

/**
 * 节点 id 换成稳定引用。文件和符号的 id 每次扫描都会变，写进仓库的导览要能在代码演进后
 * 照样找得到，所以按路径和名字记。
 */
export function stableRef(db: Db, nodeId: string): string | null {
  if (nodeId === ROOT_SCOPE) return "repo";
  if (nodeId.startsWith("pkg:") || nodeId.startsWith("dir:")) return nodeId;
  if (nodeId.startsWith("file:")) {
    const row = db.prepare("SELECT path FROM files WHERE id = ?").get(Number(nodeId.slice(5))) as { path: string } | undefined;
    return row ? `path:${row.path}` : null;
  }
  if (nodeId.startsWith("sym:")) {
    const row = db.prepare(
      "SELECT s.name, s.container, f.path FROM symbols s JOIN files f ON f.id = s.file_id WHERE s.id = ?",
    ).get(Number(nodeId.slice(4))) as { name: string; container: string | null; path: string } | undefined;
    return row ? `symbol:${row.path}#${row.container ? `${row.container}.` : ""}${row.name}` : null;
  }
  return null;
}

/** 稳定引用换回当前索引里的节点；被删或改名后为 null */
export function resolveRef(db: Db, ref: string): string | null {
  if (ref === "repo") return ROOT_SCOPE;
  if (ref.startsWith("pkg:")) return db.prepare("SELECT 1 FROM packages WHERE name = ?").get(ref.slice(4)) ? ref : null;
  if (ref.startsWith("dir:")) return db.prepare("SELECT 1 FROM directories WHERE path = ?").get(ref.slice(4)) ? ref : null;
  if (ref.startsWith("path:")) {
    const row = db.prepare("SELECT id FROM files WHERE path = ?").get(ref.slice(5)) as { id: number } | undefined;
    return row ? `file:${row.id}` : null;
  }
  if (ref.startsWith("symbol:")) {
    const rest = ref.slice(7);
    const hash = rest.lastIndexOf("#");
    if (hash < 0) return null;
    const path = rest.slice(0, hash);
    const qualified = rest.slice(hash + 1);
    const dot = qualified.lastIndexOf(".");
    const container = dot >= 0 ? qualified.slice(0, dot) : null;
    const name = dot >= 0 ? qualified.slice(dot + 1) : qualified;
    const row = db.prepare(
      `SELECT s.id FROM symbols s JOIN files f ON f.id = s.file_id
       WHERE f.path = ? AND s.name = ? AND s.container IS ? ORDER BY s.start_line LIMIT 1`,
    ).get(path, name, container) as { id: number } | undefined;
    return row ? `sym:${row.id}` : null;
  }
  return null;
}

/** 团队写下的导览，加上一条按当前结构自动生成的 */
export function listTours(db: Db, root: string): TourDto[] {
  const saved = loadConfig(root).tours.map((tour) => ({
    ...tour,
    steps: tour.steps.map((step) => ({ ...step, nodeId: resolveRef(db, step.target) })),
  }));
  return saved.some((tour) => tour.id === GENERATED_TOUR_ID) ? saved : [...saved, generateTour(db)];
}

/**
 * 按当前结构自动排一条阅读路径：先看仓库自述，再从最深的几个入口进去，然后是被签名引用最多的
 * 核心类型，接着按分层自上而下看各个模块，最后是改得勤又复杂的地方。每一步都写着为什么在这里。
 */
export function generateTour(db: Db): TourDto {
  const steps: TourStepDto[] = [
    { target: "repo", nodeId: ROOT_SCOPE, title: getMeta(db, "repo_name") ?? "repo", note: null, reason: { kind: "overview" } },
  ];
  const push = (nodeId: string, title: string, reason: TourStepDto["reason"]) => {
    const target = stableRef(db, nodeId);
    if (target === null || steps.some((step) => step.target === target)) return;
    steps.push({ target, nodeId, title, note: null, reason });
  };

  const entries = db.prepare(
    `SELECT symbol_id AS id, label, reach_symbols AS reach FROM entry_points
     WHERE symbol_id IS NOT NULL AND kind IN ('http', 'cli', 'main') AND reach_symbols > 0
     ORDER BY reach_symbols DESC, label LIMIT 3`,
  ).all() as Array<{ id: number; label: string; reach: number }>;
  for (const entry of entries) push(`sym:${entry.id}`, entry.label, { kind: "entry", count: entry.reach });

  for (const type of getSkeleton(db).types.slice(0, 3)) push(type.id, type.name, { kind: "type", count: type.uses });

  for (const module of orderedModules(db).slice(0, 6)) push(module.id, module.label, { kind: "module", count: module.dependents, ...(module.layer ? { extra: module.layer } : {}) });

  const hot = db.prepare(
    `SELECT s.id, s.name, s.container, s.complexity, h.recent FROM symbols s
     JOIN files f ON f.id = s.file_id JOIN file_history h ON h.path = f.path
     WHERE f.role = 'source' AND s.kind IN ('function', 'method') AND h.recent >= 2 AND s.complexity >= 8
     ORDER BY h.recent * s.complexity DESC LIMIT 2`,
  ).all() as Array<{ id: number; name: string; container: string | null; complexity: number; recent: number }>;
  for (const fn of hot) {
    push(`sym:${fn.id}`, fn.container ? `${fn.container}.${fn.name}` : fn.name, { kind: "hotspot", count: fn.recent, extra: fn.complexity });
  }

  return { id: GENERATED_TOUR_ID, title: "", description: null, steps: steps.slice(0, MAX_STEPS), generated: true };
}

/** 模块按分层自上而下；没有分层时按被依赖的多少从少到多（上层先读） */
function orderedModules(db: Db): Array<{ id: string; label: string; layer: string | null; dependents: number }> {
  const dependents = new Map<string, number>();
  for (const row of db.prepare(
    "SELECT dst, COUNT(DISTINCT src) AS n FROM rollup_edges WHERE level = 'package' AND type IN ('imports', 'http') GROUP BY dst",
  ).all() as Array<{ dst: string; n: number }>) dependents.set(`pkg:${row.dst}`, row.n);

  const confirmed = confirmedLayers(db);
  const layers = confirmed.length > 0
    ? confirmed.map((layer) => ({ name: layer.name, members: layer.members }))
    : (db.prepare("SELECT name, members FROM layers ORDER BY ordinal").all() as Array<{ name: string; members: string }>)
      .map((row) => ({ name: row.name, members: safeArray(row.members) }));
  if (layers.length > 0) {
    return layers.flatMap((layer) => layer.members.map((id) => ({
      id, label: id.startsWith("pkg:") ? id.slice(4) : (id.slice(4).split("/").at(-1) ?? id), layer: layer.name, dependents: dependents.get(id) ?? 0,
    })));
  }
  return (db.prepare("SELECT name FROM packages").all() as Array<{ name: string }>)
    .map((row) => ({ id: `pkg:${row.name}`, label: row.name, layer: null, dependents: dependents.get(`pkg:${row.name}`) ?? 0 }))
    .sort((a, b) => a.dependents - b.dependents || a.label.localeCompare(b.label));
}

/** 保存导览到团队约定：只存稳定引用、标题和人写的说明 */
export function saveTour(db: Db, root: string, tour: TourDto): TourDto {
  const title = tour.title.trim();
  if (title === "") throw new TourInputError("导览需要一个标题");
  const id = tour.id === GENERATED_TOUR_ID || tour.id.trim() === "" ? `tour-${Date.now().toString(36)}` : tour.id;
  const steps = tour.steps.flatMap((step): TourStepDto[] => {
    const target = step.nodeId ? stableRef(db, step.nodeId) ?? step.target : step.target;
    if (!/^(?:repo$|pkg:|dir:|path:|symbol:)/.test(target)) return [];
    return [{ target, title: step.title.trim() || target, note: step.note?.trim() || null }];
  });
  const saved: TourDto = { id, title, description: tour.description?.trim() || null, steps };
  const others = loadConfig(root).tours.filter((existing) => existing.id !== id);
  updateTeamConfig(root, { tours: [...others, saved] });
  return { ...saved, steps: steps.map((step) => ({ ...step, nodeId: resolveRef(db, step.target) })) };
}

export function deleteTour(root: string, id: string): boolean {
  const tours = loadConfig(root).tours;
  const remaining = tours.filter((tour) => tour.id !== id);
  if (remaining.length === tours.length) return false;
  updateTeamConfig(root, { tours: remaining });
  return true;
}

function safeArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
