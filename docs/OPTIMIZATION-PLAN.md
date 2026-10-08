# AI 代码可读性优化计划

出发点：AI 生成的代码越来越多、越来越复杂，负责这些代码的人对它的掌控在变弱。
RepoLens 要让人**一眼看清工程架构和实现逻辑**，细节可以不深究，但不能看错、不能看漏。

评估后确认的主要痛点，以及对应的优化项：

| 痛点 | 优化项 |
| --- | --- |
| 调用边里有「看起来确定的错边」，图不可信 | A1、A2 |
| 路由、CLI、组件组合这些 AI 最爱写的形态在图上是空白 | B1、B2、E1 |
| 关键链路噪音多，入口排序没有重点 | B3 |
| 只能看「现在的样子」，看不到 AI 这次改了什么 | C1、C2 |
| 架构约束只存在于人的脑子里，AI 越界没人发现 | D1 |
| 巨石函数/文件没有提示 | D2 |
| AI 分层只看目录名，分出来的层经常不对 | D3 |

## 进度总览

截至 2026-09-30：**12 项全部完成**。

| 编号 | 内容 | 状态 |
| --- | --- | --- |
| A1 | 调用链接可信度：显式 import 语言禁止无证据的跨文件同名兜底；`export *` 传递闭包；Go 限定同包 | ✅ 完成 |
| A2 | 类型导入与运行时依赖分开：`import type` 记为 `references`，不进架构图运行时边和循环检测 | ✅ 完成 |
| B1 | 内联 handler 合成符号：`app.get("/x", () => …)`、CLI action 的匿名函数成为可追踪入口 | ✅ 完成 |
| B2 | JSX 组件组合边：`<Comp/>` 记为 render 调用边，前端组件树可见 | ✅ 完成 |
| B3 | 关键链路降噪：同函数同类边界去重、标签裁剪、入口排序 | ✅ 完成 |
| C1 | 变更视角核心：基线提交建索引 + 结构差异（文件/符号/依赖/体检/入口/影响面），`repolens diff` | ✅ 完成 |
| C2 | Web 变更视图：`POST /changes`、左侧「变更」页、图节点变更角标 | ✅ 完成 |
| D1 | 可声明架构规则：`.repolens.json` 的 `rules` → 违规体检 + `repolens check`（CI 可用） | ✅ 完成 |
| D2 | 巨石函数/文件体检；复杂度改为只算函数自身（与 ESLint 同口径） | ✅ 完成 |
| D3 | AI 分层输入增强：模块间依赖方向、外部库、入口、导出、已有摘要；单包仓库沿 `src/` 下钻 | ✅ 完成 |
| E1 | 前后端 HTTP 连线：前端请求 URL ↔ 后端路由 handler（推断边） | ✅ 完成 |
| Z | 收尾：全量验证、自扫复验、文档更新 | ✅ 完成 |

## E1 · 前后端 HTTP 连线

- `pipeline/http-links.ts`：前端请求字面量按路径段、方法匹配后端路由；BASE 前缀和挂载点
  靠尾部对齐容忍；产出 `calls` 边（`call_kind = 'http'`，likely / ambiguous）、文件级和
  包/目录级 `http` 汇总边；`repolens scan` 的输出里报告连上的请求数
- 抽取器补洞（HTTP 连线的前提，本身也修掉一个大盲区）：
  - 顶层常量对象里的函数成为方法符号：`export const api = { load: () => … }` → `api.load`；
    `() => import(...)` 懒加载器和非标识符的键（翻译表）不算，否则一个翻译文件就多出几十个「方法」
  - `const X = memo(function X() {…})` / `forwardRef(…)` / `create(…)` 这类包装函数成为函数符号
  - `api.load()` 沿 import / re-export 精确解析到 `api.load`
  - `EXTRACTOR_VERSION` 升到 7，旧索引会自动重解析
- 包/目录图、变更差异（`repolens diff` 和 Web）、AI 分层输入都纳入 `http` 边
- 符号详情的调用方/被调方带 `HTTP` 标记，名字显示为 `容器.方法`；图上是琥珀色虚线加 `HTTP` 标签，
  帮助页有说明

验收时顺带修掉的两个问题：

- **测试文件制造的假模块环**：目录/包汇总边原来把测试文件的 import 也算进去，`enrich.test.ts`
  引用 `scan.ts` 就让 `llm ⇄ pipeline` 成了环。汇总边改为只算源码到源码，自扫的环从 6 个降到 4 个，
  剩下的 4 个两个方向都是真实的运行时 import
- **「它调用的」位置错位**：被调方显示的是「对方的文件名 + 本文件里调用发生的行号」，拼出来是个
  不存在的位置。关系数据新增 `definedAt`（对方的定义行），界面上被调方改为显示定义处；
  `line` 仍是调用行，AI 追问的上下文照旧用它

## Z · 收尾验证（2026-09-30）

- 全量 `pnpm typecheck` / `pnpm test` / `pnpm build` 通过：core 184 个、web 9 个、server 5 个测试
- 自扫 RepoLens（176 个文件、3.5 万行）：

| 项 | 结果 |
| --- | --- |
| 符号级调用边 | 普通/方法/构造调用 exact 2022、likely 63、ambiguous 10；JSX render 边 153（全部 exact）；HTTP 推断边 28（likely） |
| 文件级依赖 | imports 359、references（仅类型）106、http 2 |
| HTTP 连线 | `api/client.ts` 的 28 个请求全部唯一、方法正确地连上 27 个后端路由，无误连；包级图出现 `@repolens/web → @repolens/server` |
| 体检 | 模块环 4、重复实现 9、巨石 10，没有新符号带来的误报 |
| 关键链路 | 299 条（exact 270、likely 29）；29 个 HTTP 入口里 25 个能走到 I/O 边界 |
| 规则检查 | `repolens check` 3 条分层规则全部通过（分别检查 48 / 46 / 7 个文件） |
| 变更报告 | `repolens diff` 对比 HEAD 列出新增的 `core/src/diff` 依赖、新导出接口、`POST /changes` / `CLI diff` / `CLI check` 等新入口和受影响的链路 |

- 浏览器验收：包级图的 HTTP 边、`GET /findings` 的调用方 `api.findings`、`api.findings` 的
  调用方（`TopBar.tsx:698`、`TreePanel.tsx:465`）和被调方（`client.ts:72`、`api.ts:85`，均为定义处）
- 文档：`ARCHITECTURE.md`（置信度语义、边的种类、补出来的符号、链接顺序、变更视角数据流、架构规则）、
  `README.md`（`diff` / `check` 用法与 `rules` 格式）、`INTERACTION.md`（版本对比移出「不做的功能」、
  变更页与边样式）、`ROADMAP.md`（本计划的交付内容与验收）

## 已知限制（不在本计划内）

- 体检标题由服务端用中文生成，英文界面下不翻译（健康面板原本就是这样）
- HTTP 连线只认字面量 URL：URL 完全由变量拼出来（`${BASE}${path}`）时不连，只有包装函数的
  调用点（`get("/x")`）能连上；OpenAPI 生成的客户端、GraphQL、gRPC 不在范围内
- 后端路由只认代码里注册的（Express/Hono/Koa 风格、Python 装饰器等），Next.js 这类
  按文件路径约定的路由还没有识别
- `app.route("/api", sub)` 这类挂载关系没有真正解析，靠尾部对齐容忍；前缀不同但尾部相同的
  两个路由会判成多义（ambiguous，默认不显示）

## 验证方法

```bash
# 单元测试
pnpm -C packages/core exec vitest run
pnpm -C packages/web exec vitest run

# 自扫：同步到临时目录，避免 .repolens 污染工作区；LLM 关闭
rsync -a --delete --exclude .git --exclude node_modules --exclude dist --exclude .repolens \
  --exclude .repolens.json --exclude '*.tsbuildinfo' ./ /tmp/rl-self/
XDG_CONFIG_HOME=/tmp/rl-xdg node packages/cli/dist/bin.js serve /tmp/rl-self -p 4399

# 规则检查与变更报告
node packages/cli/dist/bin.js check /tmp/rl-self
node packages/cli/dist/bin.js diff /tmp/rl-self --base HEAD~1
```
