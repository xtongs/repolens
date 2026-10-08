import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { indexPath, openDb, type Db } from "../db/database.js";
import { getFindings, getScopeGraph } from "../db/queries.js";
import { scanRepo } from "./scan.js";

const roots: string[] = [];
beforeEach(() => {
  const configHome = mkdtempSync(join(tmpdir(), "repolens-link-config-"));
  roots.push(configHome);
  vi.stubEnv("XDG_CONFIG_HOME", configHome);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function scanFixture(files: Record<string, string>): Promise<Db> {
  const root = mkdtempSync(join(tmpdir(), "repolens-link-"));
  roots.push(root);
  writeFileSync(join(root, ".repolens.json"), JSON.stringify({ llm: { enabled: false } }));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  await scanRepo({ root, fresh: true });
  return openDb(indexPath(root), { readonly: true });
}

/** caller 所在文件:caller → callee 所在文件:callee 的全部调用边 */
function callEdges(db: Db): Array<{ from: string; to: string; confidence: string }> {
  return db.prepare(
    `SELECT fa.path || ':' || sa.name AS "from", fb.path || ':' || sb.name AS "to", e.confidence
     FROM edges e
     JOIN symbols sa ON sa.id = e.src_id JOIN files fa ON fa.id = sa.file_id
     JOIN symbols sb ON sb.id = e.dst_id JOIN files fb ON fb.id = sb.file_id
     WHERE e.type = 'calls' AND e.src_kind = 'symbol' AND e.dst_kind = 'symbol'
     ORDER BY 1, 2`,
  ).all() as Array<{ from: string; to: string; confidence: string }>;
}

describe("调用链接的证据边界", () => {
  it("TS 里没有 import 的同名调用不会连到别的文件", async () => {
    const db = await scanFixture({
      "core/db.ts": `
        export function transact(fn: () => void): void {
          const run = wrap(fn);
          run();
        }
        function wrap(fn: () => void): () => void { return fn; }
      `,
      "web/store.ts": "export function run(): void {}\n",
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "core/db.ts:transact", to: "core/db.ts:wrap", confidence: "exact" },
      ]);
    } finally { db.close(); }
  });

  it("沿 export * 与重命名导出追到定义，默认导入也是 exact", async () => {
    const db = await scanFixture({
      "src/impl/math.ts": "export function add(a: number, b: number) { return a + b; }\n",
      "src/impl/format.ts": "function fmt(x: number) { return String(x); }\nexport { fmt as format };\n",
      "src/impl/index.ts": 'export * from "./math";\nexport { format as show } from "./format";\n',
      "src/App.tsx": "export default function App() { return null; }\n",
      "src/main.ts": `
        import { add, show } from "./impl";
        import Root from "./App";
        export function main() { show(add(1, 2)); Root(); }
      `,
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "src/main.ts:main", to: "src/App.tsx:App", confidence: "exact" },
        { from: "src/main.ts:main", to: "src/impl/format.ts:fmt", confidence: "exact" },
        { from: "src/main.ts:main", to: "src/impl/math.ts:add", confidence: "exact" },
      ]);
    } finally { db.close(); }
  });

  it("CommonJS 的 require 解构也能建立绑定", async () => {
    const db = await scanFixture({
      "lib/util.js": "function helper() {}\nmodule.exports = { helper };\n",
      "lib/main.js": 'const { helper } = require("./util");\nfunction main() { helper(); }\n',
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "lib/main.js:main", to: "lib/util.js:helper", confidence: "likely" },
      ]);
    } finally { db.close(); }
  });

  it("导出函数里的闭包不算导出，不会成为公共 API", async () => {
    const db = await scanFixture({
      "package.json": JSON.stringify({ name: "closure-fixture", exports: "./src/index.ts" }),
      "src/index.ts": "export function createApi() {\n  const handler = () => 1;\n  return handler();\n}\n",
    });
    try {
      const rows = db.prepare("SELECT name, exported FROM symbols ORDER BY name").all();
      expect(rows).toEqual([
        { name: "createApi", exported: 1 },
        { name: "handler", exported: 0 },
      ]);
    } finally { db.close(); }
  });

  it("Go 的 pkg.Func() 按包目录解析，裸调用只找同包", async () => {
    const db = await scanFixture({
      "go.mod": "module example.com/app\n\ngo 1.22\n",
      "internal/store/store.go": "package store\n\nfunc Load() string { return helper() }\n",
      "internal/store/helper.go": "package store\n\nfunc helper() string { return \"x\" }\n",
      "internal/other/other.go": "package other\n\nfunc helper() string { return \"y\" }\n",
      "cmd/main.go": [
        "package main",
        "",
        'import "example.com/app/internal/store"',
        "",
        "func main() { store.Load() }",
        "",
      ].join("\n"),
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "cmd/main.go:main", to: "internal/store/store.go:Load", confidence: "exact" },
        { from: "internal/store/store.go:Load", to: "internal/store/helper.go:helper", confidence: "likely" },
      ]);
    } finally { db.close(); }
  });

  it("JSX 元素是对组件的调用：默认导入、具名导入、命名空间成员都能连上，宿主元素不算", async () => {
    const db = await scanFixture({
      "ui/Layout.tsx": "export default function Layout(p: { children: unknown }) { return <main>{p.children}</main>; }\n",
      "ui/Button.tsx": "export function Button(p: { onClick(): void }) { return <button onClick={p.onClick} />; }\n",
      "ui/cards.tsx": "export function Card() { return <div className=\"card\" />; }\n",
      "App.tsx": `
        import Layout from "./ui/Layout";
        import { Button } from "./ui/Button";
        import * as UI from "./ui/cards";
        import { Tooltip } from "some-lib";
        function Header() { return <h1>hi</h1>; }
        export function App() {
          return (
            <Layout>
              <Header />
              <Button onClick={() => {}} {...rest} />
              <UI.Card />
              <Tooltip />
            </Layout>
          );
        }
      `,
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "App.tsx:App", to: "App.tsx:Header", confidence: "exact" },
        { from: "App.tsx:App", to: "ui/Button.tsx:Button", confidence: "exact" },
        { from: "App.tsx:App", to: "ui/Layout.tsx:Layout", confidence: "exact" },
        { from: "App.tsx:App", to: "ui/cards.tsx:Card", confidence: "exact" },
      ]);
      const sites = db.prepare(
        "SELECT callee_name AS callee, call_kind AS kind, argument_texts AS args FROM call_sites WHERE call_kind = 'render' ORDER BY line, callee_name",
      ).all();
      expect(sites).toEqual([
        { callee: "Layout", kind: "render", args: "[]" },
        { callee: "Header", kind: "render", args: "[]" },
        { callee: "Button", kind: "render", args: JSON.stringify(["onClick", "{...rest}"]) },
        { callee: "Card", kind: "render", args: "[]" },
        { callee: "Tooltip", kind: "render", args: "[]" },
      ]);
    } finally { db.close(); }
  });

  it("import type 是纯类型依赖：图上单独标注，也不构成循环依赖", async () => {
    const db = await scanFixture({
      "web/client.ts": 'import type { Report } from "../server/api";\nexport function show(r: Report) { return r; }\n',
      "web/util.ts": "export function fmt(x: string) { return x; }\n",
      "server/api.ts": 'import { fmt } from "../web/util";\nexport type Report = { id: string };\nexport function make() { return fmt("x"); }\n',
    });
    try {
      const graph = getScopeGraph(db, { scope: "dir:." });
      const byPair = Object.fromEntries(graph.edges.map((edge) => [`${edge.source}->${edge.target}`, edge.type]));
      expect(byPair).toEqual({
        "dir:web->dir:server": "references",
        "dir:server->dir:web": "imports",
      });
      expect(getFindings(db, { kind: "cycle" })).toEqual([]);
    } finally { db.close(); }
  });

  it("Python 通配导入给 likely，没有导入证据的同名函数不连", async () => {
    const db = await scanFixture({
      "app/__init__.py": "",
      "app/helpers.py": "def slugify(x):\n    return x\n",
      "app/unrelated.py": "def render(x):\n    return x\n",
      "app/views.py": "from .helpers import *\n\ndef index():\n    slugify('a')\n    render('b')\n",
    });
    try {
      expect(callEdges(db)).toEqual([
        { from: "app/views.py:index", to: "app/helpers.py:slugify", confidence: "likely" },
      ]);
    } finally { db.close(); }
  });
});
