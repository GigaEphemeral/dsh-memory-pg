# dsh-memory-pg

> [!NOTE]
> **当前阶段（阶段一）**：命令式手动提炼 + 入库 + 跨项目检索，功能可用。本文档面向**用户安装与使用**；
> 开发细节、里程碑与决策记录见 [doc/](doc/) 与 [测试报告/](测试报告/)。

<!-- Hero -->
<div align="center">
  <b style="font-size: 1.15em;">DSH（DeepSeek Harness）长期记忆插件：把会话对话提炼成结构化事实存入 PostgreSQL，支持跨项目检索记忆，让经验在会话/项目间延续。</b><br /><br />
  <a href="https://www.npmjs.com/package/@GigaEphemeral/dsh-memory-pg"><img alt="npm version" src="https://img.shields.io/npm/v/@GigaEphemeral/dsh-memory-pg" /></a>
  <a href="https://github.com/GigaEphemeral/dsh-memory-pg"><img alt="GitHub" src="https://img.shields.io/github/stars/GigaEphemeral/dsh-memory-pg" /></a>
  <a href="https://opensource.org/licenses/MIT"><img alt="License: MIT" src="https://img.shields.io/badge/License-MIT-yellow.svg" /></a><br /><br />
  <a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="依赖的 DSH 版本：0.1.5-rc.1" src="https://img.shields.io/badge/DSH-0.1.5--rc.1-4d6bfe" /></a><br /><br />
  <img alt="提炼" src="https://img.shields.io/badge/-提炼-4d6bfe" /> <img alt="持久化" src="https://img.shields.io/badge/-持久化-4d6bfe" /> <img alt="检索" src="https://img.shields.io/badge/-检索-4d6bfe" /> <img alt="跨项目" src="https://img.shields.io/badge/-跨项目检索-4d6bfe" /> <img alt="设置面板" src="https://img.shields.io/badge/-设置面板-4d6bfe" />
</div>

## 📑 目录

- [✨ 项目目标](#-项目目标)
- [⚙️ 运行依赖](#️-运行依赖)
- [🚀 安装](#-安装)
- [📖 功能与操作指令](#-功能与操作指令)
- [🛠️ 本地开发与构建](#️-本地开发与构建)
- [🧠 逻辑细节](#-逻辑细节)
- [📚 详细文档](#-详细文档)

## ✨ 项目目标

DSH 的会话上下文是有限资源。会话历史超出上下文窗口后会被压缩成不可检索、跨会话不可复用的摘要——换一个会话、换一个 workspace，之前的经验就完全消失。

本插件提供一个**外部可检索的长期记忆层**：

- **提炼（distill）**：用 DSH 自身的模型能力，把当前会话上下文提炼成结构化事实（三要素：subject/predicate/object）。
- **持久化（persist）**：存入 PostgreSQL 分层四表（原始日志 / 结构化事实 / 长期知识 / 向量索引）。
- **检索（search）**：关键词优先 + 重排，**支持跨项目（workspace）检索**——在 A 项目里能查到 B 项目保存的记忆。
- **可配置（configure）**：DSH 设置面板里配置数据库连接，支持连接测试与连接状态管理。

> 🌏 **大目标：跨 IP 主机的 DSH 协作**。本插件是这条路的**阶段一小目标 + 可行性方案预研**——
> 最终目标是让**不同 IP 主机上的多个 DSH** 能通过 PostgreSQL（pgvector）联邦检索彼此主动发布的项目共享知识
> （组件契约 / 变更 / 里程碑 / 决策记录），按需获取而不必实时同步。完整需求与场景设想见
> **[doc/整体需求和使用场景设想.md](doc/整体需求和使用场景设想.md)**（多人分布式组件协同开发场景）。

**阶段一范围**：命令式手动提炼 + 入库 + 检索（单机、单库、跨项目）。多用户/多租户、跨 IP 联邦检索、
协作、上下文压力自动注入等见 [doc/阶段一task.md](doc/阶段一task.md) 的 Future backlog。

当前不足: 1.记忆提炼和官方的 /compact 还有差距, 后续考虑从官方命令入手  2.关键词优先的查询方案会有比较多无关信息,需要做清理

## ⚙️ 运行依赖

| 依赖 | 版本 | 说明 |
|---|---|---|
| **DSH** | **0.1.5-rc.1** | 插件运行宿主；`dsh web` 能正常运行即可 |
| **Node.js** | ≥ 22.5 | 构建与运行（`package.json engines`） |
| **PostgreSQL** | 任意现代版本 | 必须启用 `pg_trgm` 扩展（关键词检索主路径） |
| **pgvector** | 可选 | 仅开启向量检索时使用（默认关，F-14） |
| **Ollama / embedding 服务** | 可选 | 仅向量模式需要（OpenAI 兼容端点，默认关） |

**peer 依赖**（由 DSH web profile 提供，无需单独安装）：`@deepseek-ai/cordis`、`dsh-settings`、
`dsh-commands`、`dsh-tools`、`dsh-client-ui-slots`、`dsh-client-locale`（均 `^0.1.5-rc.1`）。

## 🚀 安装

**前置**：已装好 DSH（`dsh web` 能正常运行），Node.js ≥ 22.5。

**支持的 DSH 版本**：
<a href="https://www.npmjs.com/package/@deepseek-ai/dsh?activeTab=versions"><img alt="DSH 0.1.5-rc.1" src="https://img.shields.io/badge/DSH-0.1.5--rc.1-4d6bfe" /></a>

**方式一：dsh 命令直接安装**（推荐）：

```sh
dsh plugin --profile web add @GigaEphemeral/dsh-memory-pg@latest
```

装完**重启 DSH web**（bundle 插件 host half 生效，非 HMR），然后**硬刷新浏览器**（Cmd/Ctrl+Shift+R）。

**方式二：让 DSH 自己装**——把下面这段提示词发给任意一个 DSH 会话：

```text
帮我安装 dsh-memory-pg 插件（DSH 长期记忆插件），步骤：
1. 执行 dsh plugin --profile web add @GigaEphemeral/dsh-memory-pg@latest
2. 完成后提醒我重启 DSH web（bundle 插件 host half 生效，非 HMR）并硬刷新浏览器
遇到报错先查 https://github.com/GigaEphemeral/dsh-memory-pg README 的常见问题表。
```

**方式三：一键脚本**——克隆本仓库后执行 `scripts/install.ps1`（Windows 原生）或
`scripts/install.sh`（macOS / Linux / Windows Git Bash；`-h` 查看参数），自动完成 add。

```powershell
git clone https://github.com/GigaEphemeral/dsh-memory-pg.git
cd dsh-memory-pg
.\scripts\install.ps1          # 默认装到 web profile；-Profile m0test 指定其它 profile
```

<details>
<summary><b>更新</b></summary>

```sh
dsh plugin --profile web add @GigaEphemeral/dsh-memory-pg@latest
```

装完重启 DSH web + 硬刷新浏览器即可。

</details>

<details>
<summary><b>常见问题</b></summary>

| 现象 | 原因与解决 |
|---|---|
| 提示 `dsh: command not found` | 先安装 DSH；或改用 `npx -y --package @deepseek-ai/dsh dsh plugin --profile web add @GigaEphemeral/dsh-memory-pg@latest` |
| 报「找不到 profile 目录」 | 先跑一次 `dsh web` 让它初始化 `~/.dsh/profiles/web` |
| 装完命令/设置面板不出现 | bundle 插件 host half 需**重启 DSH web**（非 HMR），再硬刷新浏览器 |
| 「测试数据库连接」失败 | 检查 PostgreSQL 是否运行、端口/账号/密码是否正确、库内是否已启用 `pg_trgm`（`CREATE EXTENSION IF NOT EXISTS pg_trgm;`） |
| 搜索不到记忆 | 记忆按会话 cwd 目录名隔离：确认当前项目名 = 保存记忆时的目录名；跨项目检索用 `-p <项目名>`（见下文） |

</details>

## 📖 功能与操作指令

所有能力通过**斜杠命令**（在 DSH 聊天框输入，不经模型直接执行）暴露。

| 命令 | 作用 |
|---|---|
| `/memory-pg-save` | 提炼当前会话上下文 → 语义分割 → 存入记忆库 |
| `/memory-pg-compact` | 提炼当前会话上下文 → 生成一份 md 记忆文件（不自动入库，由你决定是否保存） |
| `/memory-pg-compact-save` | 免确认：提炼 + 分割 + 入库全自动 |
| `/memory-pg-search <查询词>` | 检索**当前项目**的记忆（关键词 + 重排） |
| `/memory-pg-search -p <项目名> <查询词>` | **跨项目**检索：从指定项目里搜记忆 |
| `/memory-pg-load` | （已规划，暂未实现，见 Future） |

**`-p` 参数说明**：

- `-p <项目名> <查询词>`：项目名可以是**目录名 / workspace 标题 / id**（如 `plugintest`）。
- 不带 `-p`：默认搜**当前会话所在项目**。
- 空格容错：`-p` 与项目名、查询词之间允许多个空格、Tab、全角空格。
- 未知项目会给出候选列表。

**设置面板**：左下角设置 ⚙️ → 左侧「向量记忆」→ 配置数据库连接（Host/Port/User/Password/Name）与
embedding 服务（可选），支持「测试数据库连接」与连接状态管理（重新探测 / 暂停 / 恢复 / 删除连接）。

## 🛠️ 本地开发与构建

> 代码相对路径约定：以下命令的**工作目录**分两类——**插件仓库根**（`<repo>`，即本仓库克隆目录）内执行
> 构建/测试/打包；**harness 仓库根**（`<harness>`，DSH 源码检出目录）内执行 dsh CLI 相关命令。
> 混用会报 `Cannot find package 'tsx'` 或找不到 profile。

```
dsh-memory-pg/            # ← <repo>：构建/测试/打包在这里跑
├── src/                  # TypeScript 源码（host: index/commands/store/distill/…; client: client/）
├── tests/                # vitest 单元测试（workspace/store/distill/segment/rerank/prefs）
├── scripts/              # 一键安装脚本（install.ps1 / install.sh）
├── doc/                  # 立项/任务/开发经验等文档
├── package.json          # 包名 @GigaEphemeral/dsh-memory-pg
├── cordis.patch.yml      # 组合层挂载行（name = npm 包名，勿改）
├── tsdown.config.ts      # 构建配置（client bundle id = 包名，勿改）
└── lib/                  # 构建产物（tsc + tsdown 输出，gitignore）
```

### 调试命令

```powershell
# 在 <repo> 下：
npm install          # 用 pnpm 亦可（pnpm 12；npm 10 arborist 在复杂 peer 图会崩）
npm run typecheck    # tsc --noEmit
npm run test         # vitest run（⚠️ fork worker 需要 danger-full-access 权限）
npm run build        # → lib/（tsc + tsdown）
npm pack --cache .\.npmcache   # → GigaEphemeral-dsh-memory-pg-0.1.0.tgz（npm cache 写用户目录会被沙箱拒，用工作区内 cache）
```

### 隔离测试实例（不碰生产）

```powershell
# 1. 独立 DSH_HOME（绝不用生产目录 <dshhome>）
$env:DSH_HOME = "<workspace>\.testhome"

# 2. 物化独立 profile（在 <harness> 根下；web 是 shipped 名，须用别名）
cd <harness>
node --import tsx/esm apps/cli/src/bin.ts --profile m0test --from-default-profile web --dump-config

# 3. 安装插件到隔离 profile（也可直接装本地 tgz）
node --import tsx/esm apps/cli/src/bin.ts plugin --profile m0test add "<repo>\GigaEphemeral-dsh-memory-pg-0.1.0.tgz"

# 4. 启动隔离实例（保持运行，danger-full-access；工作目录必须是 <harness>）
Start-Process node -ArgumentList "--import","tsx/esm","apps/cli/src/bin.ts","--profile","m0test","--no-open","--port","3099" -WorkingDirectory "<harness>" -RedirectStandardOutput "<workspace>\.testhome\web-m0test.log" -RedirectStandardError "<workspace>\.testhome\web-m0test.err.log"

# 5. 读 ready 行拿 token URL
Get-Content "<workspace>\.testhome\web-m0test.log"
# → dsh web: http://127.0.0.1:3099/?token=<43字符>
```

### 配置 dsh 环境的坑（踩过的，务必注意）

1. **工作目录**：所有 harness 启动命令的**工作目录必须是 harness 仓库根**（`<harness>`），否则
   `Cannot find package 'tsx'`；构建/测试/打包在插件仓库根（`<repo>`）跑。
2. **DSH_HOME 隔离**：自测只用 `.testhome`，**永不指向生产 `D:\dsharness\data`**；测试端口固定 3099，避开 3080。
3. **profile 名**：`web` 是 shipped profile 名，不能作自定义 target，须用别名（如 `m0test`）物化。
4. **升级插件后 node_modules 不刷新**：`dsh plugin add` 只更新 profile `package.json`，运行实例加载的是
   启动时刻的副本——改代码后要么新建全新 profile（最干净，绕开文件锁），要么
   `pnpm install --update-checksums`。
5. **文件锁**：旧实例还活着或 pnpm 残留进程锁着 `node_modules` 旧文件时，`pnpm install` 报
   `ERR_PNPM_PACKAGE_MANAGER_REMOVE_MODULES_DIR`——**优先新建 profile 绕开**；确需杀进程时先
   `netstat -ano` 确认 PID 用途（**切勿批量 Stop-Process，曾误杀主进程**）。
6. **端口残留**：启动新实例前旧实例还监听 3099 会 `EADDRINUSE`——先定位监听 PID 确认后停掉。
7. **单测 PG 库**：建议用**无 AGE preload** 的 PG（如 `my_pgvector`:5433），否则 `TRUNCATE` 报
   `schema "ag_catalog" does not exist`；生产库（54320）AGE 完整但 TRUNCATE 受限。
8. **测试密码**：经 `DSH_TEST_PG_PASSWORD` 环境变量提供，不硬编码在代码里；端口可用 `DSH_TEST_PG_PORT` 覆盖。
9. **沙箱权限**：vitest fork worker、npm cache 写入、docker exec 都可能在受限沙箱下被拒——按需升级
   `danger-full-access`，或把 npm cache 指到工作区内。

## 🧠 逻辑细节

### 表结构（分层四表）

| 表 | 层 | 作用 | v1 状态 |
|---|---|---|---|
| `messages` | 原始日志层 | 完整消息/事件，审计与回溯 | 写入路径已备 |
| `facts` | 结构化事实层 | 核心记忆：三要素原子事实，去重/冲突/软删/取代链 | ✅ 主路径 |
| `ltm_entries` | 长期知识层 | 摘要/知识块，上下文不足时召回 | 写入路径 v1.5 启用 |
| `embeddings` | 向量索引层 | 内容-向量分离（`ref_table`/`ref_id` 绑定），HNSW 索引 | 开向量才写 |

`facts` 关键字段：`workspace_id`（记忆归属项目，**用 cwd 目录名**，如 `plugintest`）、
`subject/predicate/object`（三要素）、`content`（完整陈述）、`tags`（标签）、`content_hash`（精确去重键）、
`status`/`superseded_by`（冲突/取代链）、`deleted_at`（软删除）。

### 大体功能流程

```
会话对话 ──(用户执行 /memory-pg-save 等)──▶ contextProvider（取当前会话 deriveMessages）
   │                                            │（过滤 system 消息，取最近 40 条）
   ▼
distill（ctx.llm.stream 提炼成三要素 JSON）
   │
   ▼
segment（过长递归分割 / 过短合并 / 精确+近似去重 / 冲突检测）
   │
   ▼
persist（写入 facts，按 workspace_id 隔离）
   │
   ▼
/memory-pg-search [-p <项目>] <查询词> ──▶ searchFacts（关键词打分 + 重排）
   │
   ▼
返回结果（命令卡片显示；跨项目检索命中目标 workspace）
```

**workspace 隔离**：记忆按 `workspace_id`（会话 cwd 目录名）隔离；`/memory-pg-search` 不带 `-p` 搜当前
项目，带 `-p` 通过 `workspaceRegistry` + 数据库已有项目列表解析目标项目后跨项目检索。

**连接管理**：`MemoryStore` 维护连接池状态（connected/paused/disconnected），支持真实可达性探测
（SELECT 1）、暂停/恢复/删除连接（`/memory-pg/api/connection.*`）。

## 📚 详细文档

- 阶段一完整开发进展（立项/需求评审/架构/决策）：[doc/阶段一项目开发进展.md](doc/阶段一项目开发进展.md)
- 阶段一任务与里程碑：`doc/阶段一task.md`
- 阶段一开发经验（踩坑/决策/流程教训）：`doc/阶段一开发经验.md`
- 大目标需求与应用场景设想（跨 IP 主机 DSH 协作）：[doc/整体需求和使用场景设想.md](doc/整体需求和使用场景设想.md)
- 阶段一测试报告：`测试报告/m2.md`、`测试报告/m3.md`、`测试报告/m4.md`
