<h1 align="center">dsh_memory_pg</h1>

<p align="center">DSH 长期记忆插件：把对话提炼成事实存入 PostgreSQL（pgvector + Apache AGE），在上下文不足时把记忆重新注入为上下文。</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-design--draft-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="dsh" src="https://img.shields.io/badge/dsh-v0.1.5--rc.1-orange">
</p>

> **文档状态：立项与规划（design draft）** — 用于对齐范围与排期，不是可照着实现的定稿规格。
> 文中标 ⚠️ 的条目是**未经实测的假设**，必须先验证再进入实现；标 ✅ 的是已在
> 本机 `D:\dsharness\sof\deepseek-harness`（分支 `v0.1.5-rc.1`）源码中**核实过**的事实。

> **修订记录**：`2026-09-14`（第一次）— 整合产品经理确认的决策（D1/D2/D3/D7、命令名统一为
> 五条、连接测试调整、AGE 否决）；被否决内容以「✗ 已否决（2026-09-14）」标注，
> 决策明细见 §13。
> `2026-09-14`（第二次）— 新增 §14–§16 参考：DSH 设置面板插件配置接入（学自
> `DSH-better-sidebar`）、DSH 插件开发约定（注释/代码风格/测试）、记忆业务逻辑
> （学自 `dsh-local-vector-memory`，仅业务逻辑，不含代码结构与 DSH 适配）。
> `2026-09-14`（第三次）— **环境更新**：harness 重装至 `v0.1.5-rc.1`（§9 契约在本版复核
> 成立）；新增 §8.0 本机环境事实表（Docker PG `dsh_memory` @54320 自带 vector/age/pg_trgm、
> Ollama `bge-m3` 1024 维）；§4.3 维度确认、§8.3/§8.4 测试方案改用现成容器、§14 版本差异
> 提示解除。
> `2026-09-14`（第四次）— **任务拆分**：新建 [`task.md`](task.md) 收纳详细待办（逐项验收
> 与备注）；README §5/§6 改为概览并链接 task.md；新增 §17 Future（暂时不做）清单。

---

## 1. 背景与目标

DSH（DeepSeek Harness）的会话上下文是有限资源。当前会话历史一旦超出上下文窗口，官方
`compaction` 会把历史压缩成一段摘要——**摘要是无结构、不可检索、跨会话不可复用的**：
换一个会话、换一个 workspace，之前的经验就完全消失。

本插件提供**外部可检索的长期记忆层**：

1. **提炼（distill）**：用 DSH 自身的模型能力把当前上下文提炼成结构化事实（JSON）。
2. **持久化（persist）**：存入 PostgreSQL；JSON 事实行 + 关键词检索为 v1 主路径，pgvector
   向量检索可选（§3.5），关系/实体用 AGE 图（v2）。
3. **注入（inject）**：上下文不足或用户显式调用时，把记忆重新注入对话。
4. **可配置（configure）**：在 DSH 设置面板里配置数据库连接与 embedding 服务（可选），支持连接测试。

**非目标（YAGNI）**：不做多用户/多租户权限、不做记忆的多人协作、不做独立的 Web 管理后台
（v1 只做设置面板 + 命令 + 工具）。

---

## 2. 需求评审

### 2.1 结论

整体方向**合理且可行**：记忆外置 + 检索注入是被反复验证的模式，且本机已有一份可运行的
同架构先例（`dsh-local-vector-memory`，SQLite + 本地 embedding，见 §7.3），技术风险可控。

但有 **6 处需要修正或补充**，其中 2 处会直接影响架构选型。

### 2.2 必须修正的点

**① ⚠️ 上下文不足时「自动注入」不能靠监听 token 数来实现 —— 应该挂 compaction seam**

你的描述是「在上下文不足的时候重新注入」。直觉做法是自己算 token、超阈值就注入。**这条路
是错的**：token 计量已经被官方明确收归单一服务，且注入时机与官方的压缩流程会打架。

✅ 核实：`ctx.compaction` 是一个正式的 capability seam（`docs/subsystems/compaction.md`），
它已经定义了**两个你正好需要的触发点**：

```ts
type CompactionTrigger = 'pressure' | 'context-overflow'
```

`CompactionEngine` 暴露 `compactIfNeeded(agent, trigger, signal)`（自动 pressure/overflow
策略）与 `compactNow(agent, signal)`（低于阈值时也强制做一次有用缩减）。

**正确做法**：通过 `agent/pre-step` waterfall 读取当前压力，并在**官方压缩即将发生前**
把记忆作为独立注入项插入（`compactNow()` 明确说明「可在待处理 prompt 之前 flush，使
后续 prompt 基于新 surface 派生」）。这样与官方压缩**协同**而非竞争。

> **决策点 D1**（✅ 已确认 `2026-09-14`）：v1 先做「命令显式注入」+ 一个手动 `compactNow`
> 触发路径；pressure 自动注入推迟到 v2。


---

**② ⚠️ `/memory_pg_load`「重新加载本对话之前的记忆」的语义与「上下文不足」是两个功能**

你的 4.2 与 4.3 描述上有重叠：一个说「重新加载本对话之前的记忆总结」，一个说「搜索部分
之前的记忆」。这是**两件事**，建议明确拆开：

- `load` = **把记忆整体注入当前上下文**（有副作用：占用 token、改变后续行为）
- `search` = **只查询并展示**，不注入（只读、零副作用）

✅ 已确认作用域决策（`2026-09-14`）：**记忆按 workspace 隔离、跨会话共享**。因此表结构需要
`workspace_id` 维度，检索默认搜整个 workspace 池，可选收窄到当前 session。

> **疑问点 1 处理（✅ 已确认 `2026-09-14`）**：
> 1. `load` 的措辞改为「重新加载**本项目**的记忆」，而不是「本对话」
> 2. `load` = **把记忆整体注入当前上下文**（有副作用）
> 3. `search` = **只查询并展示**，不注入、只读、查询历史用


---

**③ ⚠️ 命令名有拼写错误 + 命名不一致，且命令需要「结构化输入」**

原需求里 `/mermory_pg_save` 是 `memory` 的拼写错误（`mermory`）。同时三个命令前缀不统一。
产品经理已确认（`2026-09-14`）统一为**五条命令**：

| 原需求 | 最终命名（已确认） | 说明 |
|---|---|---|
| `/memory_pg_ex` | `/memory-pg-compact` | 只生成一份记忆文件（md），提炼事实，**由用户决定是否保存** |
| `/mermory_pg_save` | `/memory-pg-save` | 语义分割 + 入库 |
| —（新增） | `/memory-pg-compact-save` | **不经过用户确认**：直接完成 提炼事实 + 语义分割 + 入库 |
| `/mermory_pg_load` | `/memory-pg-load` | 注入记忆到上下文 |
| `/mermory_pg_search` | `/memory-pg-search` | 只读检索 |

✅ 核实（`packages/interaction/commands/src/types.ts:58`）：契约原文是 "Lowercase command
name without the leading slash"——**只承诺小写、不含前导斜杠**，**没有**承诺连字符可用。
⚠️ **因此 kebab-case 能否被解析是不可假设的**：必须**先写一个 hello-world 命令实测**
`/memory-pg-save` 能否被 composer 正确切分。若不行，直接退回 `/memory_pg_save`（下划线）。
这一条列入 M0 验证项。

另外 ✅ `CommandDescriptor` / `CommandDefinition` 支持声明 `input`（`CommandInputDescriptor`
含 `hint` 与 `attachments`）——所以 `/memory-pg-save 保存这个bug的排查方案` 这种「命令 +
自然语言参数」是**被支持的**。✅ 命令结果契约是 `CommandResult`：
`{ kind: 'success', text? }` 或 `{ kind: 'error', text }`，由 UI 直接渲染——无需走模型。
⚠️ 但自由输入与命令名的**切分边界**仍需实测（与上面的连字符问题一起在 M0 验证）。

> 命令命名与分工（问题点 1 + 决策点 D2）已确认，见上方表格与 §13 决策记录。

---

**④ ⚠️ `/memory_pg_ex`（导出 md 文档）与「保存到数据库」职责重叠，建议合并或明确分工**

你的 4.1 说「整理归档到一份 md 文档」，4.2 说「提炼事实存数据库」。两者**提炼逻辑相同、
出口不同**。若各写一套，会产生两套 prompt、两套质量标准和两处维护成本。

建议改为**一次提炼、两个出口**：`compact` 产出结构化对象，既可渲染成 md，也可切分入库。

> **决策点 D2**（✅ 已确认 `2026-09-14`）：md 导出**拆成独立命令** `/memory-pg-compact`
> （只生成记忆文件，由用户决定是否保存）；`/memory-pg-save` 只做语义分割 + 入库；
> 另新增 `/memory-pg-compact-save` 免确认一键完成 提炼 + 分割 + 入库。
> 即：**一次提炼逻辑，三个出口**（md 文件 / 分割入库 / 免确认全流程）。



---

**⑤ ⚠️ AGE 图数据库的收益必须被证明，否则 v1 不应上**

你要求启用 `vector` + `age`。pgvector 用途明确（语义检索），但 **AGE 的价值取决于是否真做
实体关系推理**。风险在于：

- AGE 需要 `CREATE EXTENSION age` + `LOAD 'age'` + 设置 `search_path`，**每个连接都要设**，
  与连接池配合时容易踩坑；
- 若只是「把记忆存成节点+边以备将来」，那是纯粹的复杂度开销。

**建议**：v1 只依赖 pgvector（单扩展，风险低），把 AGE 列为 **v2 增强**，且**必须先有一个
具体的图查询用例**再引入（例如「这个 bug 和哪些历史问题共享同一个根因模块」）。
若坚持 v1 上 AGE，则 §5 里程碑 M1 必须包含 AGE 的连通性与连接池实测。

> **决策点 D3**（✅ 已确认 `2026-09-14`）：**不增加 AGE**，不额外增加工作。
> ✗ 已否决（2026-09-14）：AGE 图方案（连接池 `search_path` 坑 + 收益未证）；
> 若未来有具体图查询用例再单独评审。


---

**⑥ ⚠️ 「连接测试」要覆盖三件事，不止 TCP 连通**

数据库能连上 ≠ 插件能用。连接测试按钮应**逐项校验并分项报告**：

1. TCP/认证连通（`SELECT 1`）
2. **pgvector 扩展可用**（`SELECT extversion FROM pg_extension WHERE extname='vector'`）
3. ~~**AGE 扩展可用**（若启用，同理）~~ → ✗ 已否决（2026-09-14）：不测试（AGE 不上）
4. **表结构就绪**（schema migration 是否已跑）
5. **（仅当启用向量检索时）** embedding 服务的维度与库中向量维度是否一致——最容易踩的坑：
   换了 embedding 模型导致维度不匹配，写入时静默失败。v1 默认不做向量（见 §3.5），该检查
   只在开启向量时生效

第 5 点若启用向量则尤其重要——**维度不一致必须显式报错**，不能等到写入失败才发现。

> ✅ 已确认（`2026-09-14`）：**向量维度由用户在配置页面填写**（配置项），连接测试用该值
> 与库中 `vector` 列维度比对；AGE 测试项删除。


### 2.3 无需补充的部分

设置面板配置数据库连接、用 URL 配置 embedding（如本地 Ollama，可选）、五条命令的功能划分、
存入本地 PG——这些都合理，直接做。

---

## 3. 语义分割：方案选型

这是你点名要一起想的**核心设计问题**。「先提炼、再分割、再入库」中的分割环节决定检索质量。

### 3.1 关键洞察：分割不应该对「原文」做，应该对「提炼后的事实」做

先明确分割的对象。三种可能：

| 对象 | 问题 |
|---|---|
| 原始对话文本 | 噪声大、口语化、指代多，切出来的块脱离上下文不可读 |
| 提炼后的**事实条目** | ✅ 每条已是自包含陈述，天然是语义单元 |
| 提炼后的长文档 | 需要按语义切段落，但既然能提炼就能直接产多个条目 |

**结论**：优先采用「**提炼阶段直接产出多条原子事实**」，而不是「先产出长文档再切」。
这绕开了大部分分割算法问题——**让 LLM 在提炼时就完成语义分割**，是最可靠的做法。

### 3.2 方案对比

| 方案 | 原理 | 优点 | 缺点 | 结论 |
|---|---|---|---|---|
| **A. LLM 结构化输出（推荐）** | prompt 要求直接输出 `{"facts":[{text,tags,entities}]}` | 语义单元天然正确；自带标签；无参数调优 | 依赖模型质量；需解析容错 | ✅ **v1 主方案** |
| B. 按标题/段落切 | Markdown 结构切分 | 简单、零成本、确定性 | 对无结构文本无效；块长不均 | ✅ 作为 A 的兜底 |
| C. 固定窗口 + 重叠 | 每 N 字符切，重叠 X% | 实现最简单 | **会把一句话切成两半**，语义破碎 | ⚠️ 仅作最终兜底 |
| D. Embedding 相似度突变点 | 相邻句向量余弦距离峰值处切 | 无监督、语言无关 | 阈值敏感；短文本不稳；**要多一轮 embedding 调用**（成本） | ❌ v1 不做 |
| E. 递归字符分割（LangChain 式） | 按 `\n\n`→`\n`→句号→空格 逐级降级 | 通用、保结构 | 仍是语法而非语义 | ✅ 作为 B 的补充 |

### 3.3 推荐算法（v1）

```
输入：提炼后的结构化事实列表
  │
  ├─ 每条事实 = 一个原子记忆单元（来自 LLM 结构化输出）
  │
  ├─ 过长事实（> maxChars，默认 600）：
  │     → 递归字符分割（E）兜底，保持句子完整
  │
  └─ 过短事实（< minChars，默认 20）：
        → 与相邻同类事实合并（避免碎片污染检索）
```

**为什么不做 embedding 突变点分割**：它对「已经结构化的事实」是过度设计——事实本身已经
是语义单元了。把它留给「用户直接粘贴一大段无结构文本」的场景，且推迟到 v2。

### 3.4 去重与冲突（分割后必须处理）

分割产生的碎片会与已有记忆重叠。入库前需要：

1. **精确去重**：归一化（去空白/标点）后哈希比对。
2. **近似去重**：向量相似度 > `dedupScore`（默认 0.92）直接跳过。
3. **冲突检测**：相似度在 `conflictScore`（默认 0.86）~ `dedupScore` 之间 → **不静默覆盖**，
   标记为待确认（这正好是 AGE 图在 v2 的用武之地：把「取代链」建成边）。

> ⚠️ 参考实现 `dsh-local-vector-memory` 已经验证了 0.92 / 0.86 这两个阈值可用（见
> `lib/config.mjs` 的 `compactionDedupScore` / `conflictScore`），可直接作为初值。

### 3.5 存储与检索格式：JSON vs 向量（回应你的问题）

你问「很多人用 JSON 处理记忆、不做向量，怎么看」。**我的看法：JSON 与向量不是二选一，
它们是两个正交的层**——

- **JSON 是存储格式**（一条记忆长什么样：字段、类型、标签、时间戳）
- **向量只是检索索引之一**（怎么找到记忆：相似度 vs 关键词）

**为什么「JSON + 关键词 + LLM 重排」经常是对的：**

| 优势 | 说明 |
|---|---|
| 小规模够用 | workspace 级记忆通常几十~几百条，全表扫 + 关键词 + LLM 重排，准确率不低于向量 |
| 无外部依赖 | 不需要 Ollama / 维度配置 / API 成本；离线可用、确定性、可测试 |
| LLM 重排更懂语义 | 先关键词召回候选，再让 LLM 挑相关——小池子里通常比裸余弦相似度准 |
| 可检查 | psql 直接看每行，向量是黑盒 |
| 注入场景友好 | load 注入要的是「相关」，小池关键词 + LLM 筛选已足够 |

**向量什么时候才真正赢：**

1. 记忆量上千 → 全表扫 + LLM 重排变慢变贵
2. 复述性召回：「怎么修登录 bug」vs「authentication failure 根因」——关键词漏、向量中
3. 无结构化元数据的大段自由文本

**结论（影响架构）**：v1 以 **JSON 为规范存储**（本就是事实行），检索 = **元数据过滤 +
关键词（PG trigram 索引）+ LLM 重排**；pgvector 作为**可选项渐进增强**——设置里开关，
开了才在写入时 embedding、查询时 RRF 合并。**这样插件零外部依赖即可工作**（只要 PG），
顺带消掉 §2.2⑥ 的维度不匹配隐患（只有开向量才需校验）。

> **决策点 D7**（✅ 已确认 `2026-09-14`）：向量设为**「默认关、可选开」**。
> 另新增配置项：**是否跨 workspace 查询 / 指定 workspace**（数据库中可能存多个 workspace
> 的向量）——**V1 不做**，列入 backlog（§13）。



---

## 4. 架构设计

### 4.1 形态选择

按 `make-dsh-plugin` 的 Step 0 判据：**包是否声明 `dsh.bundle.patch`**。

- 本插件需要 **Node half**（PG 连接、LLM 提炼、命令注册、工具注册）
- 本插件需要 **Client half**（设置面板卡片）
- 需要**多行组合层**（insert 自身 + config）

→ 形态 = **bundle 插件**（`dsh.bundle` + `dsh.client`），安装走
`dsh plugin --profile web add <包>`，**重启 web 生效**（不是 HMR）。

> ✅ 这与参考实现一致：`dsh-local-vector-memory` 用的正是 `dsh.bundle.patch` +
> `main: index.mjs` 的形态，且已在 `cordis.patch.yml` 里用 `- insert:` 挂载自身。

### 4.2 组件划分

```
dsh-memory-pg/
├── package.json            # dsh.bundle.patch + dsh.client + main
├── cordis.patch.yml        # 组合层：insert 自身
├── index.mjs               # Node half 入口（完整 Cordis 插件）
└── lib/
    ├── config.mjs          # 配置解析 + 默认值 + 校验
    ├── settings.mjs        # 设置命名空间注册（settingsNamespace('memory-pg')）
    ├── db.mjs              # PG 连接池 + 健康检查 + migration
    ├── schema.sql          # 建表 DDL（含 pgvector 列与索引）
    ├── embedding.mjs       # OpenAI 兼容 embedding 客户端（Ollama 可用）
    ├── distill.mjs         # 提炼：走 ctx.llm.stream()，产出结构化事实 JSON
    ├── segment.mjs         # 语义分割（§3.3）
    ├── store.mjs           # 记忆 CRUD + 检索（关键词/元数据优先 + 可选向量 RRF）
    ├── recall.mjs          # 注入策略（显式注入 / pressure 注入）
    ├── commands.mjs        # 五个 /memory-pg-* 命令注册
    ├── tools.mjs           # 模型可调用工具（memory_search 等）
    ├── rerank.mjs          # 检索后 LLM 重排（§3.5 主路径，可选）
    └── client/index.ts     # Client half：设置面板卡片
```

**每个单元的职责边界**：

| 单元 | 做什么 | 依赖 | 可独立测试 |
|---|---|---|---|
| `segment.mjs` | 纯函数：事实列表 → 分块列表 | 无（纯逻辑） | ✅ 单元测试 |
| `distill.mjs` | 上下文 → 结构化事实 | `ctx.llm` | ✅ 用 mock LLM |
| `rerank.mjs` | 候选记忆 → 按相关性重排 | `ctx.llm`（可选） | ✅ 用 mock LLM |
| `embedding.mjs` | 文本 → 向量（可选，默认关） | HTTP | ✅ 用本地 fake server |
| `store.mjs` | 记忆持久化与检索（关键词优先） | PG | ✅ 用一次性 PG 容器 |
| `recall.mjs` | 决定「注入什么、何时注入」 | store + agent | ✅ 纯函数化后可测 |

**关键设计约束**：把 `segment.mjs` 和 `recall.mjs` 写成**纯函数**（输入数据 → 输出数据，
不碰 IO）。这样核心逻辑无需 DSH、无需 PG 就能测，这是 §8 本地自测能低成本跑起来的前提。

### 4.3 数据模型（草案，⚠️ 待细化）

```sql
-- v1：JSON 事实行 + 关键词检索（§3.5）；pgvector 列可选
CREATE EXTENSION IF NOT EXISTS pg_trgm;   -- 关键词检索主路径
CREATE EXTENSION IF NOT EXISTS vector;    -- 可选：仅启用向量时使用

CREATE TABLE memory (
  id           BIGSERIAL PRIMARY KEY,
  workspace_id TEXT        NOT NULL,        -- workspace 隔离（本次已确认的决策）
  session_id   TEXT,                        -- 来源会话（可空，跨会话共享）
  kind         TEXT        NOT NULL,        -- fact | preference | decision | procedure
  content      TEXT        NOT NULL,        -- 原子事实正文
  tags         TEXT[]      DEFAULT '{}',
  embedding    vector(1024),                -- 可空：v1 默认 NULL，仅开向量后写入
  content_hash TEXT        NOT NULL,        -- 精确去重
  source_seq   BIGINT,                      -- 来源会话事件 seq（可溯源）
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at   TIMESTAMPTZ                  -- 软删除
);

CREATE UNIQUE INDEX ON memory (workspace_id, content_hash);
-- 关键词检索（v1 主路径）：trigram 让 LIKE / ILIKE 走索引
CREATE INDEX ON memory USING gin (content gin_trgm_ops);
CREATE INDEX ON memory (workspace_id, created_at DESC) WHERE deleted_at IS NULL;
-- 可选向量索引：仅当启用向量且列非空时才有意义（部分索引）
CREATE INDEX ON memory USING hnsw (embedding vector_cosine_ops)
  WHERE deleted_at IS NULL AND embedding IS NOT NULL;
```

> ✅ **维度已确认（`2026-09-14`）**：本机 embedding 模型为 `bge-m3:latest`，维度 **1024**
> （§8.0 已实测）——`vector(1024)` 即实际值，不再是占位。仍保留「向量维度由用户配置页填写」
> 的配置项（§2.2 ⑥），连接测试用该值与库中 `vector` 列比对。

### 4.4 关键数据流：提炼与入库

三条命令共用**同一条提炼管线**，仅出口不同（决策 D2，2026-09-14）：

```
用户输入 /memory-pg-save / -compact / -compact-save <参数>
  │
  ├─ 1. ctx.commands handler 被调用（不经过模型）
  ├─ 2. 取当前会话上下文（从 session 事件流，参考实现用 session/event 累积）
  ├─ 3. 走 ctx.llm.stream() 提炼 → 结构化事实 JSON    ⚠️ 见下
  ├─ 4. segment.mjs 分割 + 去重 + 冲突检测
  ├─ 5. 出口分流：
  │     ├─ /memory-pg-compact      → 生成 md 记忆文件，交用户决定是否保存（不入库）
  │     ├─ /memory-pg-save         → store.mjs 写入 PG（JSON 事实行 + trigram + content_hash）
  │     └─ /memory-pg-compact-save → 免确认：3→4→写入 PG 全自动
  │           └─ 可选：若「向量检索」开关开启 → embedding.mjs 批量向量化回填 embedding 列
  └─ 6. 返回命令结果（CommandOutcome，由 UI 直接渲染）
```

> ⚠️ **待验证的关键点**：`ctx.llm.stream()` 的**调用约定**。参考实现
> `dsh-local-vector-memory` 在 `lib/compact.mjs` 里是**直接 `fetch` 一个 OpenAI 兼容端点**
> （`cfg.compactionBaseUrl + /chat/completions`），**没有用 `ctx.llm`**。
> 两种路线各有取舍：
>
> - **路线 A：`ctx.llm.stream()`** — 复用 DSH 已配置的模型与计费，无需额外配置；
>   但需确认命令 handler 里能否安全取到 agent 上下文与路由。
> - **路线 B：独立 HTTP 端点** — 与参考实现一致、简单可控；但用户要多配一个模型地址。
>
> **决策点 D4**：走哪条？**建议先做路线 A 的可行性 spike**（半天），失败再退回 B。
> 这直接决定设置面板要不要多一组「提炼模型」配置。

### 4.5 关键数据流：注入

```
agent/pre-step (waterfall)
  │
  ├─ 读当前上下文压力（tokenMeter / compaction 状态）
  ├─ 若低于阈值 → 原样 next()，不干预
  ├─ 若接近上限 → recall.mjs 决策：
  │     ├─ 检索 workspace 下的高价值记忆（关键词/元数据优先 + LLM 重排；
  │     │    可选：开向量后并入向量相似度 RRF 合并）
  │     ├─ 按预算裁剪（不得超过注入预算）
  │     └─ 组装为一条 user/message 注入 decision.messages 末尾
  └─ 返回 { kind: 'enter', messages: [...] }
```

> ✅ 参考实现已验证这个 hook 模式可行（`index.mjs` 里 `ctx.on('agent/pre-step', ...,
> { prepend: true })`，等其它插件贡献完再追加到 `messages` 末尾）。

---

## 5. 功能规划清单

> **详细待办已移入 [`task.md`](task.md)**（按里程碑逐项列出、含验收与备注）；本节只留
> 功能一览表，供快速定位。

| ID | 功能 | 优先级 | 里程碑 |
|---|---|---|---|
| F-01 | PG 连接与连接池管理 | P0 | M2 |
| F-02 | schema 自动迁移 | P0 | M2 |
| F-03 | 设置面板：数据库连接配置 | P0 | M2 |
| F-04 | 设置面板：连接测试（分项报告） | P0 | M2 |
| F-05 | 设置面板：embedding URL 配置（Ollama 兼容，可选） | P1 | M5 |
| F-06 | 关键词/元数据检索（trigram 索引）+ LLM 重排 | P0 | M2 |
| F-07 | 提炼：上下文 → 结构化事实 JSON | P0 | M3 |
| F-08 | 语义分割 + 去重 + 冲突检测 | P0 | M3 |
| F-09 | `/memory-pg-save`（分割 + 入库） | P0 | M3 |
| F-10 | `/memory-pg-compact`（提炼 → 记忆文件，用户决定是否保存） | P0 | M3 |
| F-11 | `/memory-pg-compact-save`（免确认：提炼 + 分割 + 入库） | P0 | M3 |
| F-12 | `/memory-pg-search` | P0 | M3 |
| F-13 | `/memory-pg-load`（注入上下文） | P0 | M4 |
| F-14 | 向量写入 + 向量检索 + RRF 合并（可选，默认关） | P1 | M5 |
| F-15 | 模型可调用工具（`memory_search`） | P1 | M4 |
| F-16 | 记忆管理：列表/编辑/软删除 | P1 | M5 |
| F-17 | 上下文压力触发的自动注入 | P1 | M5→v2 |
| F-18 | 记忆统计与调试视图 | P2 | M6 |
| F-19 | ~~AGE 图：实体关系与取代链~~ → ✗ 已否决（2026-09-14） | — | — |
| F-20 | 跨 workspace 查询 / 指定 workspace 配置（backlog，V1 不做） | P3 | 未来 |

> F-18 原挂 M6（已因 D3 移除）——归入 **Future**（§17）。

---

## 6. 里程碑

> **详细任务（逐项、含验收与备注）已移入 [`task.md`](task.md)**；本节只留里程碑概览。

| 里程碑 | 内容 | 状态 |
|---|---|---|
| **M0** 技术验证（1–2 天，🎯） | 命令 kebab-case、`ctx.llm.stream()` 可用性（D4）、PG+pgvector、检索路线对比（D7 实证）、隔离实例 | ⏳ 未开始 |
| **M1** 骨架与设置面板（P0） | 仓库骨架、Node half 挂载、设置命名空间 + 卡片、连接测试、fenced 设置路由 | ⏳ 未开始 |
| **M2** 存储层（P0） | schema 迁移、连接池、CRUD、关键词检索、LLM 重排、单测 | ⏳ 未开始 |
| **M3** 提炼与保存（P0） | 提炼 prompt、分割/去重/冲突、`/save` `/compact` `/compact-save` `/search` | ⏳ 未开始 |
| **M4** 注入（P0） | `recall.mjs`、`/load`、`memory_search` 工具 | ⏳ 未开始 |
| **M5** 打磨（P1） | embedding URL、可选向量 + RRF、记忆文件/记忆管理 | ⏳ 未开始 |
| **M6** AGE 图 | ✗ 已移除（2026-09-14，D3 否决，不排期） | ✗ |
| **Future** | F-17(v2) 自动注入、F-18 统计、F-19 AGE、F-20 跨 workspace 等 | 📋 backlog（§17） |

> 每个里程碑的**退出标准**见 [`task.md`](task.md) 对应小节。

---

## 7. 开发所需的 MCP / 工具

你问「需要哪些 mcp 工具来帮助开发」。**直接结论：这个插件本身不需要新增任何 MCP server**，
但开发过程中需要几类能力。逐项说明：

### 7.1 插件自身对外暴露的能力（不是 MCP）

| 能力 | 形式 | 说明 |
|---|---|---|
| `/memory-pg-*` | ✅ **Cordis 命令**（`ctx.commands`） | **不要做成 MCP**——命令是「不经模型直接执行」的，符合你的需求 |
| `memory_search` 等 | ✅ **Cordis 工具**（`defineTool`） | 模型主动检索用 |
| 设置面板 | ✅ **Client Slot** | 不是 MCP |

> **重要区分**：`dsh.mcpServers` 是「把外部 MCP server 引入 DSH」。你的需求是「向 DSH
> 注册能力」，方向相反。**本插件不应声明 `dsh.mcpServers`**（除非将来要把 PG 记忆暴露给
> 外部 MCP 客户端）。

### 7.2 开发期建议的工具辅助

| 用途 | 工具 | 说明 |
|---|---|---|
| 查确切 API | ✅ **`cordis_inspect_query`** | 写代码前查 `ctx.commands` / `ctx.llm` / `ctx.settings` / Slot 的真实签名 |
| 查 Slot 树 | ✅ **`cordis_inspect_query`** (`Slots.listSubTree`) | 设置面板槽必须先查再注册 |
| 热验证 UI | ✅ **`cordis_define` + `cordis_run`** | 用动态插件快速验证设置卡片，不必反复重启 |
| 读 DSH 源码 | ✅ 本地 `read`/`grep` | 仓库就在本机，比任何 MCP 都直接 |
| PG 操作 | ⚠️ **psql / pgAdmin / DBHub 之类 MCP** | 调试期查库；**建议用 CLI，不要引入 MCP 依赖进产品** |
| 结构化调试 | 自建 fake embedding server | 见 §8.3 |

> **建议**：不要为了开发的便利在产品里引入 MCP 依赖。开发期的工具与产品的运行时不绑定。

### 7.3 ✅ 已有可复用先例（强烈建议先读）

本机 `D:\000CODE\dsh-memory-pg\dsh-local-vector-memory` 是一份**已工作的同架构实现**
（v0.2.1，MIT）。它验证了本方案中大部分高风险假设：

| 已解决 | 位置 |
|---|---|
| bundle 形态 + `cordis.patch.yml` 挂载 | `package.json` / `cordis.patch.yml` |
| `agent/pre-step` 注入 hook（`prepend: true`） | `index.mjs:59-69` |
| embedding 客户端（OpenAI 兼容 + 批量 + 归一化） | `lib/embedding.mjs` |
| 提炼 prompt + JSON 容错解析（含平衡括号提取） | `lib/compact.mjs` |
| 去重/冲突阈值（0.92 / 0.86） | `lib/config.mjs` |
| 配置解析与 clamp 校验模式 | `lib/config.mjs` |
| 单元测试写法 | `tests/*.test.mjs` |

**它没解决、需要本项目新做的**：PostgreSQL 后端（它是 SQLite）、设置面板 UI（它是配置文件）、
`ctx.commands` 命令（它是自建工具）、AGE 图。

> **建议**：把 `dsh-memory-pg` 做成它的 **PG 后端变体**，复用 `embedding.mjs` /
> `compact.mjs` / `config.mjs` 的结构。这能省掉大量试错。⚠️ 需先确认两仓库的授权与归属。

---

## 8. 本地自测方案（不影响现有 DSH）

### 8.0 本机环境事实（✅ 已核实 `2026-09-14`）

| 项 | 值 | 核实方式 |
|---|---|---|
| 项目路径 | `D:\000CODE\dsh-memory-pg\dsh-memory-pg` | — |
| harness 源码 | `D:\dsharness\sof\deepseek-harness`，**`dsh-v0.1.5-rc.1`**（2026-09-14 完整重装） | `git describe` → `dsh-v0.1.5-rc.1` |
| DSH_HOME | `D:\dsharness\data`（环境变量已设） | `$env:DSH_HOME` |
| `~/.dsh` | 存在：`C:\Users\CZQ\.dsh`（目录） | `Test-Path` |
| 运行中的 DSH web | `http://127.0.0.1:3080`（本会话即用它，**不可污染**） | — |
| **PostgreSQL（Docker）** | `localhost:54320`，库 `postgres`，用户 `postgres`，密码 `czq` | TCP 54320 OPEN；`docker ps` → `dsh_memory`（`dawsonlp/postgres-batteries-inc:latest`，healthy） |
| — 已装扩展 | **`vector 0.8.6` + `age 1.8.0` + `pg_trgm 1.6`** + postgis 等 | `docker exec dsh_memory psql … \dx` |
| **Ollama** | `http://localhost:11434/` | `GET /api/tags` OK |
| — embedding 模型 | **`bge-m3:latest`（1.08 GB，维度 1024）** | `GET /api/tags` |
| — 其它模型 | `Qwen3.5:9B`、`deepseek-r1:14b`、`qwen2.5:14b` | `GET /api/tags` |

**含义**：
- 数据库**直接用现有 `dsh_memory` 容器**（自带 vector+age，无需再拉镜像）；测试时**新建独立
  database**（如 `dsh_memory_pg_test`），测完 drop，不动 `postgres` 库。
- embedding **实测维度 = 1024**（bge-m3）——§4.3 数据模型 `vector(1024)` 占位由此确认。
- ⚠️ **版本升级提示**：harness 从 v0.1.3 升到 v0.1.5-rc.1 后，先前在 v0.1.3 上核实的契约
  （§9）已在本版源码复核仍成立；settings 命名空间校验已转为编译期模板字面量（与
  `DSH-better-sidebar` 的 0.1.5-rc.2 线一致，§14 的版本差异提示可解除）。

**约束**：现有 DSH 通过 `dsh web` 服务本会话（`http://127.0.0.1:3080`）。自测绝不能污染它。

### 8.1 核心隔离手段：`DSH_HOME`

✅ 核实：`DSH_HOME` 环境变量控制 DSH 的全部用户态数据（本机当前 = `D:\dsharness\data`），
包括 `settings.yaml`、`sessions/`、`skills/`、`storages/`、`profiles/`。

**因此：用一个新的 `DSH_HOME` 起第二个实例，与正在运行的实例完全隔离**——配置、会话历史、
已装插件互不干扰。

```powershell
# 完全隔离的测试实例（不要动 D:\dsharness\data）
$env:DSH_HOME = "D:\000CODE\dsh-memory-pg\.testhome"
# 另起一个端口，避免和 3080 冲突
dsh web --port 3099
```

> ⚠️ **待验证**：`dsh web` 的端口参数名（`--port`?）与是否支持与源码 run 方式共用。
> 这一条在 M0 验证（`scripts/dev-web.ts` 与 `dsh web` CLI 在 0.1.5-rc.1 上的实际行为为准）。

### 8.2 四层测试策略

| 层 | 范围 | 怎么跑 | 是否需要 DSH |
|---|---|---|---|
| **L1 纯逻辑** | `segment.mjs`（分割/去重）、`recall.mjs`（预算裁剪） | `node --test tests/*.test.mjs` | ❌ 不需要 |
| **L2 外部服务** | `embedding.mjs`、`store.mjs` | 一次性 PG 容器 + fake embedding server | ❌ 不需要 |
| **L3 集成** | 命令注册、提炼、注入 | 隔离 `DSH_HOME` 的第二实例 | ✅ 隔离实例 |
| **L4 端到端** | 真实对话中 `/memory-pg-save` → 新会话 `load` | 浏览器操作隔离实例 | ✅ 隔离实例 |

**关键**：把逻辑写成纯函数（§4.2），让 L1/L2 覆盖大部分逻辑，**L3/L4 只做接线验证**。
这样迭代速度最快，也最不容易伤到主实例。

### 8.3 测试用的 fake embedding server

单测/集成测试**不要依赖真实 Ollama**（慢、不可复现、占用 GPU）。写一个 30 行的 Node HTTP
server 返回**确定性向量**（例如对文本做哈希种子生成），让测试可复现：

```
POST /v1/embeddings  →  { data: [{ embedding: [确定性向量] }] }
```

> 向量维度按真实模型对齐：本机 `bge-m3` = **1024 维**（§8.0）。fake server 默认返回
> 1024 维确定性向量；换模型维度时改配置即可。真实 Ollama 只用于**端到端冒烟**（L4）。

### 8.4 PG 测试环境

✅ 本机已有现成容器（§8.0）：`dsh_memory`（`localhost:54320`，`postgres`/`czq`，
自带 `vector` + `age` + `pg_trgm`）。**不再需要拉新镜像**：

- **方式一（推荐，本机现成）**：用 `dsh_memory` 容器，**新建独立 database**：
  ```powershell
  docker exec dsh_memory psql -U postgres -c "CREATE DATABASE dsh_memory_pg_test;"
  # 连接串: postgres://postgres:czq@localhost:54320/dsh_memory_pg_test
  # 测完: docker exec dsh_memory psql -U postgres -c "DROP DATABASE dsh_memory_pg_test;"
  ```
  ⚠️ 每个测试库要 `CREATE EXTENSION vector`（扩展是实例级装的，库级需各自启用）。
- **方式二**：本机其它已有 PG 实例（如 `my_pgvector` 容器在 5433），同样新建独立 database
  测完 drop。

### 8.5 安全护栏

- [ ] 自测**只用** `.testhome`，**永不**指向 `D:\dsharness\data`
- [ ] 测试端口固定用 3099，避开 3080
- [ ] 测试完成后 drop 测试 database
- [ ] 不修改 `D:\dsharness\sof\deepseek-harness` 源码（它是运行中的 host）
- [ ] 用 `git` 管理插件仓库，便于回滚

---

## 9. 已核实的 DSH 契约（✅ 来源：本机源码）

| 契约 | 位置 | 结论 |
|---|---|---|
| 命令注册表 | `ctx.commands`（`docs/subsystems/commands.md`） | ✅ 存在；命令名小写无斜杠；支持 `input` |
| 压缩 seam | `ctx.compaction`（`docs/subsystems/compaction.md`） | ✅ 存在；`pressure` / `context-overflow` 触发 |
| 设置命名空间 | `ctx.settings.register()`（`packages/settings/settings`） | ✅ 存在；支持 `applies` / `watch` |
| LLM 流式 | `ctx.llm.stream()` / `registerAdapter` | ✅ 存在；⚠️ 命令中可用性待验 |
| 技能根目录 | `<DSH_HOME>/skills/<name>/SKILL.md` | ✅ 一层深，kebab-case |
| 数据根 | `DSH_HOME` | ✅ 默认 `~/.dsh`，本机 `D:\dsharness\data` |
| bundle 形态 | `dsh.bundle.patch` → `cordis.patch.yml` | ✅ 重启生效（非 HMR） |

---

## 10. 风险登记

| # | 风险 | 影响 | 缓解 |
|---|---|---|---|
| R1 | `ctx.llm.stream()` 在命令中不可用 | 需增加「提炼模型」配置 | M0 先做 spike（D4） |
| R2 | ~~AGE + 连接池的 `search_path` 问题~~ | 连接不稳定 | ✗ 已否决（2026-09-14，D3）：不上 AGE，风险消除 |
| R3 | embedding 维度与库不一致（仅向量模式） | 写入静默失败 | 显式校验（§2.2 ⑥）；v1 默认不走向量，无此风险 |
| R4 | 提炼质量不稳定 / JSON 解析失败 | 记忆污染 | 容错解析 + 人工确认（参考实现已有模式） |
| R5 | 自动注入挤占上下文 | 反而加速溢出 | 严格注入预算 + 优先级排序 |
| R6 | kebab-case 命令名不被 composer 识别 | 需改名 | M0 实测 |
| R7 | 现有 DSH 被自测污染 | 影响你当前工作 | §8 隔离方案 |
| R8 | 与官方 compaction 冲突 | 注入被压缩覆盖 | 协同而非竞争（§2.2 ①） |
| R9 | 关键词检索召回差（同义/复述查不到） | 记忆「搜不到」 | M0 对比验证；LLM 重排补语义；必要时开向量（§3.5） |

---

## 11. 决策状态汇总（2026-09-14 全部确认）

| 编号 | 问题 | 最终决策（已确认 `2026-09-14`） |
|---|---|---|
| **D1** | 自动注入时机 | 先显式注入 + 手动 `compactNow` 触发路径；pressure 自动注入 → v2 |
| **D2** | md 导出职责 | 独立命令 `/memory-pg-compact`；`/memory-pg-save` 只分割入库；新增 `/memory-pg-compact-save` 免确认一键完成 |
| **D3** | AGE 图 | **不上**（✗ 否决，不排期） |
| **D4** | 提炼走 `ctx.llm.stream()` 还是独立端点 | 路线 A（`ctx.llm.stream()`）为默认，**M0 spike 验证后定**（技术项，非产品决策） |
| **D5** | `kind` 分类 | 采纳 fact/preference/decision/procedure（用户总确认默认采纳） |
| **D6** | 记忆置顶/核心记忆 | 保留（用户总确认默认采纳） |
| **D7** | 检索主路径 + 向量 | JSON+关键词+LLM 重排为主，向量默认关可选开；跨 workspace 查询配置 → backlog（V1 不做） |
| 连接测试 | AGE / 维度 | AGE 测试项删除；向量维度由用户配置页填写 |

**仍待 M0 技术验证（非产品决策）**：命令 kebab-case 切分、`ctx.llm.stream()` 在命令中可用性
（D4）、PG+trigram/pgvector 可用、检索路线对比（D7 实证）、隔离实例方案。

---

## 12. 下一步

1. ✅ **D1–D7 已确认**（2026-09-14）
2. 执行 **M0 技术验证**（见 §6），把高危假设打掉（含 D4、D7 实证）
3. M0 通过后，用 `writing-plans` 出**可执行的实施计划**，然后进入实现

> 本文档是**立项与规划**。进入实现前会产出独立的实施计划（分任务、可验证、带 TDD 步骤）。

---

## 13. 决策记录（2026-09-14）

> 本次整合产品经理确认的全部决策；所有修改时间 `2026-09-14`。

| # | 决策内容 | 结果 |
|---|---|---|
| D1 | 自动注入时机 | v1 显式注入 + 手动 `compactNow`；pressure 自动 → v2 |
| 疑问点 1 | `load` / `search` 语义 | `load`=注入本项目记忆；`search`=只读查询历史 |
| 问题点 1 | 命令名统一 | 五条：compact / save / compact-save / load / search（kebab-case 待 M0 实测） |
| D2 | md 导出 | `/memory-pg-compact` 生成记忆文件由用户决定保存；`/memory-pg-save` 分割入库；新增 `/memory-pg-compact-save` 免确认全流程 |
| D3 | AGE | ✗ 否决，不增加工作、不排期 |
| 连接测试 | AGE 项 / 维度 | AGE 测试删除；向量维度用户配置页填写 |
| D7 | 向量 | 默认关、可选开；跨 workspace 查询配置 → backlog（V1 不做） |

---

## 14. 参考：在 DSH 设置面板注册插件配置（学自 `DSH-better-sidebar`）

> 来源：本机 `D:\000CODE\dsh-memory-pg\DSH-better-sidebar`（v0.19.1，`@deepseek-ai/*@0.1.5-rc.2`
> 依赖线）。本插件的设置面板需求（左下角设置 → 左侧列表出现 `dsh_memory_pg` 配置）照此实现。

### 14.1 两种「配置」的分工（关键）

| 层 | 存放 | 谁写 | 用途 |
|---|---|---|---|
| **部署配置** | `cordis.patch.yml` 插件行 `config` | 部署者手改 | 主机行为默认值（如超时、上限） |
| **用户偏好** | settings 命名空间（`dsh-memory-pg`） | 用户在设置面板改 | 数据库连接 / embedding URL / 维度等 |

`DSH-better-sidebar` 正是这样拆的：`src/config.ts` 的 `Config`（部署配置）+ `PrefsSchema`
（用户偏好，命名空间 `dsh-better-sidebar`）。**本插件的数据库连接、embedding URL 属于用户
偏好层**，走 settings 命名空间；部署兜底值放 `config`。

### 14.2 宿主侧：注册设置命名空间（`src/index.ts` 的 `ctx.inject(['settings'], …)`）

```ts
// DSH 0.1.5 起命名空间校验是编译期模板字面量，直接传常量即可
const ns = 'dsh-memory-pg'   // 小写字母开头 + [a-z0-9-] 尾部
const scope = ctx.settings.register(ns, PrefsSchema)   // schemastery schema
// 读取（含 revision，供 CAS）
const descriptor = ctx.settings.describe({ redactSecrets: true })
  .find(candidate => candidate.ns === ns)
// 更新（revision 守卫：并发修改抛 settings-conflict）
await ctx.settings.update(ns, patch, expectedRevision)
// 订阅：设置提交后重新计算工具注册等门控
scope.watch(() => { /* 幂等重算 */ })
```

> ✅ **版本差异已消除（`2026-09-14`）**：本机 harness 已重装为 **v0.1.5-rc.1**，与
> `DSH-better-sidebar` 的 0.1.5-rc.2 依赖线同代。上例写法（命名空间编译期校验、无运行时
> `settingsNamespace` helper）已在本机源码核实成立（`packages/settings/settings` 导出
> `SettingsNamespaceInput` 模板字面量类型）。M0 仍用 `cordis_inspect_query` 核实 `ctx.settings`
> 真实签名后定稿。

要点（全部来自 `DSH-better-sidebar` 实测）：

- `settings` 是**可选服务**：用 `ctx.inject(['settings'], cb)` 挂接，缺失时降级为默认值，
  插件照常工作。
- **浏览器侧不能直连 settings RPC**：DSH 的 settings RPC 域只服务白名单命名空间。插件必须
  自建 **fenced 路由**（如 `/memory-pg/api/settings.get` / `settings.update`）在进程内调
  settings seam，客户端经插件路由读写。（`DSH-better-sidebar` 的 `settings.get` /
  `settings.update` 路由即此模式。）
- schema 用 schemastery：布尔 `z.boolean().default(true)`、数字 `z.number().step(1).min().max()`、
  开放 map `z.dict(z.dict(z.any())).default({})`（插件自有字段不丢）。

### 14.3 客户端：注册设置面板分区（`src/client/index.tsx`）

```tsx
ctx.slots.inject('settings.section', () => ctx.slots.register({
  name: 'settings.section',
  id: 'dsh-memory-pg',
  order: 100,
  label: () => 'dsh_memory_pg',          // 左侧列表显示名
  inject: () => ({ /* 传给设置组件的服务/状态 */ }),
}, SettingsSection))
```

- 这会让插件出现在**设置壳左侧列表**（`settings.section` 槽）。
- `DSH-better-sidebar` 额外用 `registerSettingsNavIcon`（DOM 标记）替换壳渲染的通用齿轮图标
  —— 可选优化，v1 可先不做。
- 设置 UI 组件内通过 `settingsScope`/插件自有路由读写命名空间；**快照必须引用稳定**
  （React `useSyncExternalStore` 要求：值未变时返回同一对象，否则 React #185 无限重渲）。

### 14.4 声明式设置行（`pluginSettings` 开放 map）

`DSH-better-sidebar` v0.12.0 起的做法：插件自有设置不侵入宿主 schema，而是存进
`pluginSettings[<descriptorId>]` 开放 map（`z.dict(z.dict(z.any()))`）。本插件可用同一模式：

- 数据库连接字段（host/port/user/password/dbname）、embedding URL、向量维度、跨 workspace
  开关（backlog）全部放自己的命名空间；
- 值须 JSON 可序列化；`parsePrefs` 逐字段校验 + 失败回退默认值（客户端永不信任线缆值）。

---

## 15. 参考：DSH 插件开发约定（学自 `DSH-better-sidebar`）

> 注释代码风格、测试、仓库纪律——照搬能少踩大量坑。

### 15.1 代码/注释风格（实测自其源码）

- **JSDoc 契约式注释**：每个导出函数/类型用 `/** … */` 写清职责、参数（`@param`）、返回
  （`@returns`）、边界条件；`@module` 标注文件归属。示例见其 `src/prefs-shared.ts`、
  `src/config.ts`。
- **命名空间常量集中定义**：`SIDEBAR_PREFS_NS = 'dsh-better-sidebar'` 单点定义，两端共享
  （`prefs-shared.ts` 同时被 host 与 client 引用，且**不引 schemastery**，避免浏览器包拖入
  schema 运行时）。
- **每字段带默认值与范围常量**：如 `TERMINAL_FONT_SIZE_MIN/MAX/DEFAULT`，clamp 函数两端共用。
- **ESLint**（`eslint.config.js`）：`@eslint/js recommended` + `typescript-eslint recommended`
  （非 type-checked 档）+ react-hooks（仅经典双规则，关掉 React Compiler 语义档）；
  `no-unused-vars` 允许 `^_` 前缀占位；孤儿 eslint-disable 注释报错；globals 按运行域分治
  （client→browser，host→node，tests→混合）。
- **栅栏纪律**：client bundle 禁止 value-import 非白名单包；重依赖（xterm/CodeMirror/mermaid）
  走懒加载 chunk；i18n 词典集中，新增 key 必须同步全部语言词典。

### 15.2 测试约定（vitest + Playwright）

- **纯逻辑单元测试**（host，无浏览器）与 **jsdom 组件测试**（文件头 `// @vitest-environment
  jsdom`）分离；e2e 用 `*.e2e.ts` 命名 + vitest `exclude` 双保险。
- **`vitest.config.ts`**：`testTimeout: 15_000`（Windows 真起进程的用例 5000ms 不够）；
  `exclude` 必须**显式重列**默认排除项（整体替换默认值）。
- **契约守护测试**：不测行为而测「契约不变」——如 `manifest-consistency.spec.ts`（打包产物
  与声明一致）、`market-manifest.spec.ts`（依赖不含 `cordis`、无 install 脚本）、
  `theme.spec.ts`（样式零硬编码颜色）。
- **挂载冒烟**：`pnpm build && pnpm pack` → 装进 scratch profile → 真实 `dsh web` 启动 →
  Playwright 断言挂载成功、无 console 错误（本插件 §8 自测方案 L3/L4 可复用此法）。

### 15.3 仓库纪律（AGENTS.md）

- **禁止修改 DSH 源码**；插件以独立 npm 包被 profile 引用，不反向侵入。
- 依赖约束：`dependencies`/`peerDependencies`/`optionalDependencies` **不得出现 `cordis`**
  （按名硬拒），`scripts` 不得含 `preinstall`/`install`/`postinstall`/`prepare`。
- 缺能力时用 DSH 现成公开 API 或插件自有路由，不改 DSH。

---

## 16. 参考：记忆业务逻辑（学自 `dsh-local-vector-memory`，仅业务逻辑）

> ⚠️ 按你的要求：**只借鉴**「记忆存储 / 提取 / 分割」**业务逻辑**；**不借鉴**其代码结构
> （SQLite 单文件、embedding 客户端实现）与 DSH 适配（hook/工具注册）。本节提炼可直接
> 迁移到 PostgreSQL + 本插件架构的语义。

### 16.1 存储语义（可移植到 PG 表）

其 `lib/store.mjs` 的 `memories` 表暴露了值得保留的**业务语义**：

| 语义 | 参考实现 | 本插件落地 |
|---|---|---|
| 软删除 | `deleted_at` 标记，`restore()` 可恢复；`forget(soft=false)` 硬删 | PG `deleted_at` 列（已入 §4.3 草案） |
| **取代链** | `superseded_at` / `superseded_by`：旧记忆被新记忆「修正/取代」时打标记 | **冲突检测（§3.4）的落点**——相似度落在冲突区间时不覆盖，而是标记取代链 |
| 置顶核心记忆 | `pinned` 列 + `listPinned()`（会话首次召回整体注入） | 决策 D6（保留） |
| 来源与作用域 | `source` / `session_id` / `cwd` 列 | PG 用 `workspace_id` / `session_id`（workspace 隔离） |
| 标签规范化 | `normalizeTags`：去重、去空白、最多 20 个 | 直接复用 |
| 统计 | `stats()`：total/vectorized/pinned/superseded/missingVectors/dimensions | 设置面板调试视图（F-18） |

### 16.2 提取与分割（其 `lib/extract.mjs` 已验证的 prompt 与容错）

- **提取 prompt 纪律**：只提取「跨会话仍有价值的事实/偏好/约定/决定/环境约束」；不提取寒暄、
  过程细节、工具输出、临时路径；每条是独立完整陈述；**只输出 JSON**
  `{"memories":[{"text","tags"}]}`；没有可记内容输出空数组。⚠️ 本插件的 /compact 系命令
  的提炼 prompt 照此撰写。
- **长上下文分块**：`splitTranscript` 按段落打包到 `chunkChars`（默认 1000），超长段落硬切，
  最多 `maxChunks` 块——逐块提炼后合并（防一次请求超限）。
- **JSON 容错解析三级**：整段 JSON → 剥代码块 → 提取第一个平衡大括号对象（`extractBalancedObject`）。
  模型输出不干净时不会全丢。
- **去重**：归一化（去空白）后哈希比对，`<4` 字符丢弃，`seen` 集合防跨块重复。

### 16.3 检索融合（其 `store.mjs` 的 RRF 算法）

`search()` 用**向量 + 关键词双信号 RRF 融合**（本插件 §3.5 已采纳关键词优先，向量可选）：

```text
score = Σ 1/(k + rank)     k=60（常数）
```

- 双信号都在时按 RRF 排序（`match:'rrf'`）；单信号时按原分数（`match:'vector'|'keyword'`）；
- 向量结果不足 limit 时用关键词**补位**；
- 中文关键词打分 `keywordScore`：查询分词（≥2 字符词），CJK 连续串 ≤4 字整串、>4 字用
  二元组近似；命中率 = hits/terms。

> 本插件 v1 主路径 = 关键词（PG trigram）+ LLM 重排；若开向量，直接复用此 RRF 融合公式
> （PG 侧用 `vector_cosine_ops` 距离替换其内存余弦）。

---

## 17. Future（暂时不做）

> 以下特性**明确暂不排期**（已否决或 backlog）；不做不代表永久否决，触发条件满足时再评审。
> 详细登记见 [`task.md`](task.md) 的 Future 小节。

| ID | 特性 | 状态 | 触发条件/备注 |
|---|---|---|---|
| F-19 | AGE 图：实体关系与取代链 | ✗ 否决（D3，2026-09-14） | 需先有具体图查询用例（如「bug 与历史问题共享根因模块」）；`dsh_memory` 容器自带 `age 1.8.0`，复活零部署成本 |
| F-20 | 跨 workspace 查询 / 指定 workspace 配置 | backlog（V1 明确不做） | 数据库可能存多 workspace 向量时再评估 |
| F-17(v2) | 上下文压力自动注入 | v2（D1：v1 只做显式注入 + 手动 `compactNow`） | v1 交付后再排 |
| F-18 | 记忆统计与调试视图 | backlog | 原挂 M6（已移除）；设置面板成熟后再说 |
| — | embedding 突变点分割（§3.2 方案 D） | v1 不做 | 对结构化事实是过度设计；留给「粘贴无结构长文本」场景 |
| — | 多用户/多租户权限、多人协作、独立 Web 管理后台 | §1 非目标（YAGNI） | — |

---

## 附录：与参考实现的差异对照

| 维度 | `dsh-local-vector-memory` | `dsh_memory_pg`（本项目） |
|---|---|---|
| 存储 | SQLite（单文件） | **PostgreSQL** |
| 检索主路径 | 向量（内存暴力） | **JSON 事实行 + 关键词（trigram）+ LLM 重排**（§3.5） |
| 向量 | 必须（依赖 embedding 服务） | **可选、默认关**（pgvector + HNSW，F-14） |
| 图 | 无 | ~~AGE~~ ✗ 否决（2026-09-14，D3） |
| 配置方式 | `cordis.patch.yml` 手写 | **设置面板 UI** + 连接测试 |
| 调用入口 | 自建工具 | **`/memory-pg-*` 命令** + 工具 |
| 提炼 | 独立 HTTP 端点（9B 本地模型） | ⚠️ 待定（D4），倾向 `ctx.llm` |
| 作用域 | 全局 | **workspace 隔离** |
| 注入 | `agent/pre-step` 自动召回 | 显式 `load` + 压力触发（v2） |
