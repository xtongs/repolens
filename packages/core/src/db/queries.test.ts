import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./database.js";
import { getScopeGraph, getTree } from "./queries.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("目录角色过滤", () => {
  it("默认隐藏只含配置文件的目录，显示噪音时恢复", () => {
    const db = fixtureDb();
    try {
      expect(getScopeGraph(db, { scope: "dir:.", roles: ["source"] }).nodes.map((n) => n.id))
        .toEqual(["dir:src"]);
      expect(getTree(db, ".", 1, ["source"]).children?.map((n) => n.id))
        .toEqual(["dir:src"]);

      const roles = ["source", "config"] as const;
      expect(getScopeGraph(db, { scope: "dir:.", roles: [...roles] }).nodes.map((n) => n.id).sort())
        .toEqual(["dir:.cursor", "dir:src"]);
      expect(getTree(db, ".", 1, [...roles]).children?.map((n) => n.id).sort())
        .toEqual(["dir:.cursor", "dir:src"]);
    } finally {
      db.close();
    }
  });
});

function fixtureDb(): Db {
  const root = mkdtempSync(join(tmpdir(), "repolens-role-query-"));
  roots.push(root);
  const db = openDb(join(root, "index.db"));
  db.prepare(
    "INSERT INTO directories (path, parent_path, name, depth) VALUES (?, NULL, ?, 1)",
  ).run(".cursor", ".cursor");
  db.prepare(
    "INSERT INTO directories (path, parent_path, name, depth) VALUES (?, NULL, ?, 1)",
  ).run("src", "src");

  insertFile(db, ".cursor/rules/project.mdc", ".cursor", "project.mdc", "other", "config");
  insertFile(db, "src/main.ts", "src", "main.ts", "typescript", "source");
  return db;
}

function insertFile(
  db: Db,
  path: string,
  dirPath: string,
  name: string,
  language: string,
  role: string,
): void {
  db.prepare(
    `INSERT INTO files
       (path, dir_path, name, language, role, loc, bytes, hash, parsed, complexity)
     VALUES (?, ?, ?, ?, ?, 1, 1, ?, 1, 1)`,
  ).run(path, dirPath, name, language, role, `hash:${path}`);
}
