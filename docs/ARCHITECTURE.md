# RepoLens 架构设计

## 一句话

RepoLens 是一个本地运行的代码仓库理解工具：CLI 扫描仓库产出一份确定性的代码知识图谱（SQLite），
本地 Web UI 以渐进式下钻的方式可视化架构、目录、调用关系、函数传参与逻辑伪代码。

## 设计立场

这类工具最容易崩塌的地方是**可信度**。一旦用户发现图上的一条调用边是模型编出来的，
整张图的价值就归零了。所以 RepoLens 的第一原则是：

> **结构由解析器决定，语义由模型补充，两者在数据模型里严格分离，并在 UI 上可区分。**

具体体现：

| 内容 | 来源 | 是否可能出错 |
| --- | --- | --- |
| 文件、目录、包、语言、行数 | 文件系统 | 否 |
| 函数/类/结构体定义、位置、签名 | tree-sitter AST | 否 |
| import 语句、导出符号 | tree-sitter AST | 否 |
| import 目标文件 | 各语言模块解析器 | 可解析失败，但不会猜 |
| 调用边 | AST 调用点 + 解析器 | 分四档置信度，见下 |
| 摘要、伪代码、架构分层命名 | LLM | 是，UI 明确标注为 AI 生成 |

参考实现 [Understand Anything](https://github.com/Egonex-AI/Understand-Anything) 的做法是：
tree-sitter 只提取 `{ caller: string, callee: string, lineNumber }`（纯名字，无目标文件），
再由 LLM agent 拿着 importMap 去推断 callee 属于哪个文件。这意味着调用图的正确性依赖模型。
RepoLens 把这一步做成确定性的，代价是每种语言要写一个模块解析器。

## 调用边置信度模型

每条 `calls` 边带 `confidence` 字段：

| 档位 | 判定条件 | UI 呈现 | 默认可见 |
| --- | --- | --- | --- |
| `exact` | 同文件内唯一定义，或通过 import 唯一解析到目标文件的导出符号 | 实线 | 是 |
| `likely` | 全局符号名匹配且候选唯一（无 import 证据，如 Go 同包、Python 通配导入） | 虚线 | 是 |
| `ambiguous` | 同名候选多个，全部记录在 `candidates` 里 | 点线 + 角标数字 | 否，需手动打开 |
| `external` | 解析到第三方依赖或语言内置 | 聚合进单个 external 节点 | 折叠 |

`ambiguous` 默认隐藏是刻意的：宁可少画一条边，也不画一条错边。

## 包结构

```
repolens/
├── packages/
│   ├── core/      @repolens/core     领域类型、解析、解析器、索引管线、SQLite 持久层、LLM 客户端
│   ├── server/    @repolens/server   本地 HTTP API（读 SQLite，按需拉子图）
│   ├── cli/       @repolens/cli      repolens 命令入口
│   └── web/       @repolens/web      React + React Flow 前端
└── docs/
```

依赖方向严格单向：`web → server → core`，`cli → server + core`。
`web` 只以 `import type` 方式从 `@repolens/core/types` 取类型，不引入任何运行时代码。

## core 内部分层

```
core/src/
├── types.ts              纯类型，零运行时依赖（web 也从这里取类型）
├── config.ts             RepolensConfig 与 .repolens.json 加载
├── registry.ts           扫过的仓库清单（~/.repolens/repos.json）
├── db/
│   ├── schema.sql        DDL
│   ├── database.ts       打开 / 迁移 / WAL / 事务
│   ├── writer.ts         批量写入
│   └── queries.ts        读查询（server 消费）
├── discovery/
│   ├── ignore.ts         .gitignore + 默认忽略规则
│   ├── language.ts       语言注册表：扩展名 / grammar / extractor / resolver
│   ├── roles.ts          source / test / config / generated / types / docs 分类
│   ├── workspace.ts      monorepo 包检测（pnpm / npm / go.mod / Cargo / pyproject）
│   └── walk.ts           目录遍历
├── parse/
│   ├── parser-pool.ts    web-tree-sitter 实例复用
│   └── extractors/       每语言一个：符号 / import / 导出 / 调用点
├── resolve/              每语言一个模块解析器：import 说明符 → 文件 → 符号
├── pipeline/
│   ├── scan.ts           扫描编排
│   ├── fingerprint.ts    内容指纹与增量判定
│   ├── metrics.ts        LOC / 圈复杂度
│   └── rollup.ts         文件边 → 目录边 → 包边聚合
└── llm/                  可插拔 OpenAI 兼容客户端 + prompt + 缓存
```

## 解析流水线

```
1. discover    遍历文件系统，应用 ignore，分类 role，检测语言，识别 workspace 包
2. fingerprint 计算内容哈希，与上次扫描比对，得出 changed / unchanged / deleted
3. parse       对 changed 文件跑 tree-sitter，提取符号、import、导出、调用点
4. resolve     import 说明符 → 目标文件 id；导入名 → 目标符号 id（构建符号索引）
5. link        调用点 → 目标符号 id，打 confidence 标签
6. rollup      文件级 import/calls 边按目录、包聚合，算权重
7. enrich      （M3）LLM 生成仓库总览、包摘要；函数级摘要与伪代码按需生成
```

第 3-5 步是纯函数式的，输入相同必然输出相同，这是增量更新和结果可复现的基础。

### 语言能力分层

- **专用分析**：TypeScript / JavaScript、Python、Go、Rust，有语言专属 extractor 和 resolver。
- **复合组件**：Vue、Svelte 的 `<script>` 与 Astro frontmatter 会转成等字节、等换行的虚拟
  JS/TS 源码，因此符号、调用和错误行号仍可直接映射回原文件。
- **通用结构分析**：Java、C/C++、C#、PHP、Ruby、Shell、PowerShell 复用已分发的
  tree-sitter grammar，保守提取声明、调用和 import；没有证据时不猜模块目标。
- **文本源码兜底**：其余已知语言和未知文本仍进入文件图、LOC 统计与文件级 AI 理解；
  只有检测到 NUL 或异常控制字符比例时才按二进制资源隐藏。

`discovery/language.ts` 是唯一语言能力注册表。外部扩展可在扫描前调用
`registerLanguagePlugin({ definition, extractor, resolver })` 一次注册 grammar、专用抽取器和
模块解析器；只需通用抽取时也可调用较低层的 `registerLanguage(...)`。插件 ID 必须使用
`custom:*` 命名空间，且不能覆盖内置 ID 或扩展名。

## 存储

SQLite（`better-sqlite3`），默认落在 `<repo>/.repolens/index.db`。

选 SQLite 而不是单个 JSON 的原因：目标规模是 40 万行 / 1400 文件量级的 monorepo，
全量图 JSON 会到几十 MB，前端一次性加载必然卡。SQLite + HTTP API 让前端**按需拉子图**，
同时天然支持增量写入和后续的 chat 检索。

索引跟着仓库走（而不是集中存在某个全局目录）也是刻意的：它是可重建的派生数据，
跟着仓库才能随仓库一起删掉。代价是没有任何地方知道「这台机器上扫过哪些仓库」，
所以另有一份清单 `~/.repolens/repos.json` 补这个缺口，界面的仓库选择器读它。
清单是便利缓存而非事实来源——状态一律现场探测，解析失败就当空清单。

### 多仓库寻址

API 用 `?repo=<id>` 指定仓库，缺省落到启动时那个。`id` 是绝对路径的短哈希，
定长且 URL 安全。服务端按仓库各持一份只读连接和一个 `createApi` 子应用，
外层中间件按请求分发，所以 `api.ts` 完全不需要知道多仓库的存在；连接数有上限，
超出按最久未用关闭，启动时那个固定驻留。

**可达范围就是安全边界**：只能打开清单里已有的仓库或启动时指定的那个，
API 不接受任意路径。`/source` 会按仓库根读源码，如果允许现场指定路径，
任何能连上这个端口的东西就都能读机器上的任意文件。新仓库必须先在本地
`repolens scan` 一次，那是一次显式的本地操作。

## 模块解析器要点

### TypeScript / JavaScript
- 说明符候选扩展：`.ts .tsx .d.ts .js .jsx .mjs .cjs` + `/index.*`
- `tsconfig.json` 的 `baseUrl` / `paths`（含 `extends` 链）
- workspace 包名 → 包目录（`package.json` 的 `exports` / `main` / `module` / `types`）
- `import` / `export from` / `require()` / 动态 `import()`
- 符号级：命名导入直接对应导出名；`export *` 需要传递闭包

### Python
- `from .x import y` / `from ..x import y` 相对导入按包层级回溯
- 绝对导入按 source roots（仓库根、`src/`、含 `pyproject.toml` 的目录）尝试
- `__init__.py` 包目录解析；`from pkg import mod` 的模块/符号二义性两边都试

### Go
- `go.mod` 的 `module` 前缀 → 目录映射
- Go 的 import 是**包级**的：`pkg.Func` 先定位包目录，再在该目录所有文件里找导出符号
- 同包内跨文件调用无需 import，判定为 `likely`（候选唯一时）

### Rust
- `mod` 声明构建模块树（`foo.rs` / `foo/mod.rs`）
- `use crate::a::b` / `super::` / `self::` 路径解析
- Cargo workspace members → crate 名映射

## 前端渲染策略

- 图库：`@xyflow/react` v12
- 布局：`elkjs`（分层布局）跑在 Web Worker 里，避免主线程阻塞
- 默认视图节点数控制在 30 以内；超过阈值自动聚合为「其他 N 项」节点
- 所有下钻请求走 API，前端不持有全图

详细交互规范见 [INTERACTION.md](./INTERACTION.md)。
