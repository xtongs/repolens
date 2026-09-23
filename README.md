# RepoLens

本地运行的代码仓库理解工具。CLI 扫描仓库产出一份确定性的代码知识图谱（SQLite），
本地 Web UI 以渐进式下钻的方式看清架构、目录、调用关系，并指出结构上的问题。

面向的场景是**读别人的（或 AI 写的）大仓库**：40 万行量级的 monorepo 全量扫描约 8 秒，
之后按内容指纹增量更新。

TypeScript / JavaScript、Python、Go、Rust 提供专用结构与模块分析；Vue、Svelte、
Astro 会分析组件中的 JS/TS 脚本并保持原文件行号；Java、C/C++、C#、PHP、Ruby、
Shell、PowerShell 提供通用结构分析。其他常见编程语言及未知文本源码仍会显示、
统计并支持文件级 AI 理解，但不会伪造尚不可靠的符号依赖和调用关系。

## 环境要求

- Node.js >= 20.11
- pnpm 9.13.2（仓库已用 `packageManager` 锁定，`corepack enable` 后会自动对齐）

## 安装

```bash
pnpm install
pnpm build
```

`pnpm build` 必须跑一次：CLI 从 `packages/*/dist` 加载，前端资源也是从
`packages/web/dist` 读的。

## 快速开始

最省事的是 `open`——需要时自动扫描，然后起服务并打开浏览器：

```bash
pnpm lens open /path/to/some-repo
```

它会在被扫描的仓库下生成 `.repolens/index.db`，然后在
<http://127.0.0.1:7173> 打开界面。

## 命令

| 命令 | 作用 |
| --- | --- |
| `scan [path]` | 扫描仓库，写入 `<仓库>/.repolens/index.db` |
| `serve [path]` | 只起服务浏览已有索引，不扫描 |
| `open [path]` | 必要时扫描 + 起服务 + 打开浏览器 |
| `info [path]` | 在终端打印索引摘要，不起服务 |

`path` 一律可省略，默认当前目录。

常用参数：

| 参数 | 适用命令 | 说明 |
| --- | --- | --- |
| `-f, --fresh` | `scan` `open` | 忽略已有索引，全量重建 |
| `-q, --quiet` | `scan` | 只输出最终结果，不打进度条 |
| `-p, --port <port>` | `serve` `open` | 端口，默认 7173 |
| `--host <host>` | `serve` | 监听地址，默认 `127.0.0.1` |
| `--open` | `serve` | 启动后打开浏览器 |

仓库里的 `lens` 脚本就是 CLI 入口，所以用 `pnpm lens <命令>`。
`@repolens/cli` 声明了 `repolens` 这个 bin，如果想全局直接敲 `repolens`，
可以在 `packages/cli` 下 `pnpm link --global`。

### 默认端口为什么是 7173

避开 5173（Vite dev）、3000、8080 这些高频占用的端口，也避开 5000 / 7000
——macOS 的 AirPlay 接收器默认占着那两个。

## 多个仓库

扫过的仓库会记进 `~/.repolens/repos.json`，**界面顶栏的仓库名就是个下拉，
可以直接切换或添加仓库**，不必重启进程或换端口。点击「添加本地仓库」后，
系统目录选择器会让你选择代码目录；界面会显示扫描阶段、文件数和总进度，
完成后自动切换到新仓库。
当前仓库会写入 URL 的 `repo` 参数，因此刷新页面或复制链接后仍会定位到同一仓库。

也可以继续使用命令行添加：

```bash
pnpm lens scan ~/Workspace/pi
```

之后它就出现在下拉里了。可视化添加不会接受网页提交的任意绝对路径：本机服务
直接唤起 macOS 系统目录选择器，并只扫描用户在系统窗口里明确选择的目录。扫描
任务放在独立 Worker 中，建立索引期间不会阻塞界面的进度查询。

索引存在每个被扫描仓库自己的 `.repolens/` 目录下，互不干扰，第二次打开秒开。
建议把 `.repolens/` 加进被扫描仓库的 `.gitignore`——它是可重建的派生数据。

仓库被删或索引被清掉后，它在下拉里会灰掉并说明原因，可以就地从列表移除
（只动列表，不动仓库和索引）。

真要同时开两个窗口对比，换端口各起一个也照样可以：

```bash
pnpm lens serve ~/Workspace/pi -p 7174
```

## LLM 语义层

RepoLens 的结构图和调用关系始终由解析器生成；LLM 只补充明确标为 **AI 生成** 的
仓库/包/目录摘要、架构分层、文件摘要、函数伪代码和关键链路叙述。模型不可用时会自动退化为纯结构模式。

共享的模型配置写在 `~/.config/repolens/config.json`（若设置了
`XDG_CONFIG_HOME`，则写在 `$XDG_CONFIG_HOME/repolens/config.json`）：

```json
{
  "llm": {
    "baseUrl": "http://127.0.0.1:8317/v1",
    "model": "GPT-5.4",
    "interactiveModel": "GPT-5.2",
    "apiKeyEnv": "TRAEX_BRIDGE_API_KEY",
    "outputLanguage": "zh",
    "enabled": true
  }
}
```

Key 只通过环境变量读取，不要写进 JSON：

```bash
export TRAEX_BRIDGE_API_KEY="$(cat ~/.traex-bridge/api-key)"
pnpm lens scan /path/to/some-repo
```

配置按以下顺序合并，后者覆盖前者：

```text
内置默认值 → ~/.config/repolens/config.json → <仓库>/.repolens.json
```

多数情况下只需配置一次全局文件。仓库内 `.repolens.json` 是可选覆盖层，适合设置
`exclude` / `include`、文件角色覆盖，或对敏感仓库单独设置 `"llm": { "enabled": false }`；若使用，
建议将它加入该仓库的 `.gitignore`。两个配置文件都只保存环境变量名，不保存 API Key。

噪音分类默认参考常见生态约定和 GitHub Linguist：测试、配置、生成代码、文档、
第三方依赖默认不进入主干图。遇到仓库自己的特殊约定时，用 `roleOverrides` 做最终裁决：

```json
{
  "roleOverrides": {
    "runtime/**/*.json": "source",
    "fixtures/**/*.ts": "test",
    "src/legacy-generated/**": "generated"
  }
}
```

glob 后写的规则优先。可用角色为 `source`、`test`、`config`、`generated`、
`types`、`docs`、`asset`、`vendor`；修改后重新扫描即可生效。扫描还会遵循仓库根目录的
`.gitignore`、`.repolensignore` 以及 `exclude` / `include`。

扫描期只生成仓库、包和目录级语义；文件摘要、函数伪代码和链路叙述在界面中按需生成，
并按源码内容指纹缓存在 `.repolens/index.db`。代码未变时不会重复请求模型。兼容 Ollama
等无需鉴权的本地接口时，把 `apiKeyEnv` 配成空字符串即可。完整可选项还包括
`interactiveModel` 可给详情抽屉选一个低延迟模型（不填就沿用 `model`）。其他可选项包括
`maxConcurrency`、`reasoningEffort`、`maxOutputTokens`、`requestTimeoutMs`、`maxRetries`、`scanBatchSize` 和
`scanMaxCalls`（扫描期硬上限为 99 次）。

## 界面能看到什么

- **架构图**：包 → 目录 → 文件 → 函数逐层展开，双击展开/收起，Alt+双击聚焦
- **调用图**：以某个符号为中心的 N 跳上下游，方向、跳数、置信度可调
- **详情抽屉**：签名、参数、位置、源码切片、调用方与被调方
- **架构体检**：确定性地指出重复实现与循环依赖，角标直接画在节点上
- **关键链路**：识别 main / HTTP / CLI / 包公共 API / 测试入口，优先列出能沿调用边到达数据库、网络、文件系统、消息队列或外部进程的有效路径；未形成链路的候选默认折叠
- **链路时序视图**：按执行顺序分入口、内部调用、I/O 边界三条泳道，以绿色实线和琥珀虚线区分确定步骤与静态推断
- **数据结构流转**：根据参数与返回类型展示类型经过的函数，并明确标为签名推断
- **⌘K 搜索**：跨符号与文件，回车直接把图导航过去
- **仓库切换**：顶栏下拉在已扫过的仓库间切换

交互设计遵循《简约至上》的四策略，详细规范见 [docs/INTERACTION.md](docs/INTERACTION.md)。

## 可信度：哪些是解析出来的，哪些是猜的

这类工具最容易崩塌的地方是可信度——一旦发现图上有一条边是编出来的，整张图就没价值了。
所以 RepoLens 把结构与语义严格分开：**结构由解析器决定，语义由模型补充**，
并且在 UI 上可区分。

调用边分四档置信度：

| 档位 | 判定条件 | 默认可见 |
| --- | --- | --- |
| `exact` | 同文件内唯一定义，或经 import 唯一解析到目标符号 | 是（实线） |
| `likely` | 全局名匹配且候选唯一（如 Go 同包） | 是（虚线） |
| `ambiguous` | 同名候选多个，全部记录下来 | 否，需手动打开 |
| `external` | 第三方依赖或语言内置 | 聚合折叠 |

`ambiguous` 默认隐藏是刻意的：宁可少画一条边，也不画一条错边。

关键链路同样遵守这个边界：默认只沿 `exact` / `likely` 调用边，`exact` 使用绿色实线，
`likely` 使用琥珀虚线，不会把静态启发式冒充实际运行轨迹。LLM 只解释
已经生成的步骤，不能添加、删除或重排链路。

## 开发

```bash
pnpm test        # 全部单测
pnpm typecheck   # 四个包的类型检查
pnpm build       # 全量构建
pnpm clean       # 清掉所有构建产物
```

改前端时不必每次 `build`——用 Vite 开发服务器配合已启动的 API：

```bash
pnpm lens serve /path/to/some-repo   # 一个终端：API
pnpm dev:web                         # 另一个终端：带 HMR 的前端
```

`packages/web/vite.config.ts` 里的代理会把 `/api` 转到 7173。

## 包结构

```
packages/
├── core/     @repolens/core     类型、解析、模块解析器、扫描管线、SQLite 持久层
├── server/   @repolens/server   本地 HTTP API（读 SQLite，按需拉子图）
├── cli/      @repolens/cli      repolens 命令入口
└── web/      @repolens/web      React + React Flow 前端
```

依赖方向严格单向：`web → server → core`，`cli → server + core`。
`web` 只以 `import type` 从 `@repolens/core/types` 取类型，不引入任何运行时代码。

## 文档

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) —— 架构设计、置信度模型、各语言模块解析器要点
- [docs/INTERACTION.md](docs/INTERACTION.md) —— 交互规范
- [docs/ROADMAP.md](docs/ROADMAP.md) —— 里程碑与进展
