# dsh_memory_pg

DSH（DeepSeek Harness）长期记忆插件：把会话对话提炼成结构化事实存入 PostgreSQL，支持跨项目检索记忆，让经验在会话/项目间延续。

## 1. 项目目标

DSH 的会话上下文是有限资源。会话历史超出上下文窗口后会被压缩成不可检索、跨会话不可复用的摘要——换一个会话、换一个 workspace，之前的经验就完全消失。

本插件提供一个**外部可检索的长期记忆层**：

- **提炼（distill）**：用 DSH 自身的模型能力，把当前会话上下文提炼成结构化事实（三要素：subject/predicate/object）。
- **持久化（persist）**：存入 PostgreSQL 分层四表（原始日志 / 结构化事实 / 长期知识 / 向量索引）。
- **检索（search）**：关键词优先 + 重排，**支持跨项目（workspace）检索**——在 A 项目里能查到 B 项目保存的记忆。
- **可配置（configure）**：DSH 设置面板里配置数据库连接，支持连接测试与连接状态管理。

**当前阶段（阶段一）范围**：命令式手动提炼 + 入库 + 检索。多用户/多租户、协作、独立 Web 后台、上下文压力自动注入等见 `doc/阶段一task.md` 的 Future backlog。

## 2. 功能与操作指令

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

**设置面板**：左下角设置 ⚙️ → 左侧「向量记忆」→ 配置数据库连接（Host/Port/User/Password/Name）与 embedding 服务（可选），支持「测试数据库连接」与连接状态管理（重新探测 / 暂停 / 恢复 / 删除连接）。

## 3. 安装

前置：DSH（v0.1.5-rc.1）、PostgreSQL（含 `pg_trgm`；可选 `vector` 扩展）、可选 Ollama（embedding，默认关）。

```powershell
# 1. 构建并打包（在插件仓库目录）
npm install          # 用 pnpm 亦可（pnpm 12）
npm run build        # → lib/
npm pack --cache .\.npmcache   # → dsh-memory-pg-0.1.0.tgz

# 2. 安装到 DSH profile（harness 根目录下执行）
node --import tsx/esm apps/cli/src/bin.ts plugin --profile <p> add "<插件仓库>\dsh-memory-pg-0.1.0.tgz"

# 3. 确认挂载
node --import tsx/esm apps/cli/src/bin.ts --profile <p> --dump-config | findstr memory-pg

# 4. 重启 DSH web 实例后生效（非 HMR）
```

安装后在设置面板填入数据库连接并「测试数据库连接」，然后就能用 `/memory-pg-*` 命令。

## 4. 本地开发

### 调试命令

```powershell
# 类型检查
npx tsc --noEmit

# 单元测试（⚠️ vitest fork worker 需要 danger-full-access 权限）
npx vitest run

# 构建
npm run build        # tsdown → lib/index.mjs + lib/client.js

# 打包
npm pack --cache .\.npmcache
```

### 隔离测试实例（不碰生产）

```powershell
# 1. 独立 DSH_HOME（绝不用生产目录）
$env:DSH_HOME = "<workspace>\.testhome"

# 2. 物化独立 profile（web 是 shipped 名，需用别名）
node --import tsx/esm apps/cli/src/bin.ts --profile m0test --from-default-profile web --dump-config

# 3. 安装插件到隔离 profile
node --import tsx/esm apps/cli/src/bin.ts plugin --profile m0test add "<仓库>\dsh-memory-pg-0.1.0.tgz"

# 4. 启动隔离实例（保持运行，danger-full-access）
Start-Process node -ArgumentList "--import","tsx/esm","apps/cli/src/bin.ts","--profile","m0test","--no-open","--port","3099" -WorkingDirectory "<harness-root>" -RedirectStandardOutput "<workspace>\.testhome\web-m0test.log" -RedirectStandardError "<workspace>\.testhome\web-m0test.err.log"

# 5. 读 ready 行拿 token URL
Get-Content "<workspace>\.testhome\web-m0test.log"
# → dsh web: http://127.0.0.1:3099/?token=<43字符>
```

**注意事项**：

- 测试库建议用无 AGE preload 的 PG（否则 TRUNCATE 会报 `ag_catalog does not exist`），或经 `DSH_TEST_PG_*` 环境变量指定。
- 单测 PG 密码经 `DSH_TEST_PG_PASSWORD` 提供，不硬编码在代码里。
- 更新插件代码后需重新 `npm pack` → `dsh plugin add` → 重启实例；旧实例残留会占用 3099，先停掉再启动新实例。

## 5. 逻辑细节

### 表结构（分层四表）

| 表 | 层 | 作用 | v1 状态 |
|---|---|---|---|
| `messages` | 原始日志层 | 完整消息/事件，审计与回溯 | 写入路径已备 |
| `facts` | 结构化事实层 | 核心记忆：三要素原子事实，去重/冲突/软删/取代链 | ✅ 主路径 |
| `ltm_entries` | 长期知识层 | 摘要/知识块，上下文不足时召回 | 写入路径 v1.5 启用 |
| `embeddings` | 向量索引层 | 内容-向量分离（`ref_table`/`ref_id` 绑定），HNSW 索引 | 开向量才写 |

`facts` 关键字段：`workspace_id`（记忆归属项目，**用 cwd 目录名**，如 `plugintest`）、`subject/predicate/object`（三要素）、`content`（完整陈述）、`tags`（标签）、`content_hash`（精确去重键）、`status`/`superseded_by`（冲突/取代链）、`deleted_at`（软删除）。

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

**workspace 隔离**：记忆按 `workspace_id`（会话 cwd 目录名）隔离；`/memory-pg-search` 不带 `-p` 搜当前项目，带 `-p` 通过 `workspaceRegistry` + 数据库已有项目列表解析目标项目后跨项目检索。

**连接管理**：`MemoryStore` 维护连接池状态（connected/paused/disconnected），支持真实可达性探测（SELECT 1）、暂停/恢复/删除连接（`/memory-pg/api/connection.*`）。

### 详细文档

- 阶段一完整开发进展：`doc/阶段一项目开发进展.md`
- 阶段一任务与里程碑：`doc/阶段一task.md`
- 阶段一开发经验（踩坑/决策/流程教训）：`doc/阶段一开发经验.md`
- 阶段一测试报告：`测试报告/m2.md`、`测试报告/m3.md`、`测试报告/m4.md`
