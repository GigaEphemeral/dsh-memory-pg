<h1 align="center">dsh_memory_pg</h1>

<p align="center">DSH 长期记忆插件：把对话提炼成事实存入 PostgreSQL（pgvector + Apache AGE），在上下文不足时把记忆重新注入为上下文。</p>

<p align="center">
  <img alt="status" src="https://img.shields.io/badge/status-design--draft-blue">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-green">
  <img alt="dsh" src="https://img.shields.io/badge/dsh-v0.1.3--alpha.1-orange">
</p>

> **文档状态：立项与规划（design draft）** — 用于对齐范围与排期，不是可照着实现的定稿规格。
> 文中标 ⚠️ 的条目是**未经实测的假设**，必须先验证再进入实现；标 ✅ 的是已在
> 本机 `D:\dsharness\sof\deepseek-harness`（分支 `v0.1.3`）源码中**核实过**的事实。

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

> **决策点 D1**：v1 是先做「命令显式注入」（低风险、可控），还是直接做「pressure 自动
> 注入」？建议 v1 先做显式 + 一个手动 `compactNow` 触发路径，v2 再接自动。


✅ 产品经理决策点1决策: v1 先做显式 + 一个手动 `compactNow` 触发路径


---

**② ⚠️ `/memory_pg_load`「重新加载本对话之前的记忆」的语义与「上下文不足」是两个功能**

你的 4.2 与 4.3 描述上有重叠：一个说「重新加载本对话之前的记忆总结」，一个说「搜索部分
之前的记忆」。这是**两件事**，建议明确拆开：

- `load` = **把记忆整体注入当前上下文**（有副作用：占用 token、改变后续行为）
- `search` = **只查询并展示**，不注入（只读、零副作用）

✅ 已确认作用域决策（本次澄清）：**记忆按 workspace 隔离、跨会话共享**。因此表结构需要
`workspace_id` 维度，检索默认搜整个 workspace 池，可选收窄到当前 session。

> 这也意味着 `load` 的措辞应改为「重新加载**本项目**的记忆」，而不是「本对话」。




✅  产品经理疑问点1处理:
1. `load` 的措辞应改为「重新加载**本项目**的记忆」，而不是「本对话」
2. `load` = **把记忆整体注入当前上下文**
3. `search` = **只查询并展示**，不注入,只读,查询历史用


---

**③ ⚠️ 命令名有拼写错误 + 命名不一致，且命令需要「结构化输入」**

原需求里 `/mermory_pg_save` 是 `memory` 的拼写错误（`mermory`）。同时三个命令前缀不统一。
建议统一为：

| 原需求 | 建议命名 | 说明 |
|---|---|---|
| `/memory_pg_ex` | `/memory-pg-compact`（⚠️ 连字符待 M0 实测，不行则用 `_`） | 见下方 ④，这个命令的定位需要重新考虑 |
| `/mermory_pg_save` | `/memory-pg-save`（同上） | 提炼事实 + 语义分割 + 入库 |
| `/mermory_pg_load` | `/memory-pg-load`（同上） | 注入记忆到上下文 |
| `/mermory_pg_search` | `/memory-pg-search`（同上） | 只读检索 |

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



✅  产品经理问题点1处理:
`/memory_pg_ex` 改为  `/memory-pg-compact`
`/mermory_pg_save` 改为 `/memory-pg-save`
`/mermory_pg_load`  改为 `/memory-pg-load`
`/mermory_pg_search`  改为 `/memory-pg-search`



✅  产品经理决策点 D2处理:
`/memory-pg-compact` 改为只生成一份记忆文件, 提炼事实, 由用户决定是否保存
用`/memory-pg-save` 语义分割 + 入库
新增  `/memory-pg-compact-save` 用于不经过用户确认, 直接 完成 提炼事实 + 语义分割 + 入库  入库的操作


---

**④ ⚠️ `/memory_pg_ex`（导出 md 文档）与「保存到数据库」职责重叠，建议合并或明确分工**

你的 4.1 说「整理归档到一份 md 文档」，4.2 说「提炼事实存数据库」。两者**提炼逻辑相同、
出口不同**。若各写一套，会产生两套 prompt、两套质量标准和两处维护成本。

建议改为**一次提炼、两个出口**：`compact` 产出结构化对象，既可渲染成 md，也可切分入库。
是否保留 md 导出作为独立命令，取决于你是否真的需要「给人看的文档」这个交付物。

> **决策点 D2**：md 导出是**独立命令**，还是 `save` 的一个参数（如 `--md`）？


✅  产品经理决策点 D2处理: 如上
`/memory-pg-compact` 改为只生成一份记忆文件, 提炼事实, 由用户决定是否保存
用`/memory-pg-save` 语义分割 + 入库
新增  `/memory-pg-compact-save` 用于不经过用户确认, 直接 完成 提炼事实 + 语义分割 + 入库  入库的操作



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

> **决策点 D3**：v1 是否真的需要 AGE？（建议：不需要）

✅  产品经理决策点 D3处理: 
不额外增加工作, 不增加AGE


---

**⑥ ⚠️ 「连接测试」要覆盖三件事，不止 TCP 连通**

数据库能连上 ≠ 插件能用。连接测试按钮应**逐项校验并分项报告**：

1. TCP/认证连通（`SELECT 1`）
2. **pgvector 扩展可用**（`SELECT extversion FROM pg_extension WHERE extname='vector'`）
( 产品经理决策: 不测试 )3. **AGE 扩展可用**（若启用，同理）
4. **表结构就绪**（schema migration 是否已跑）
5. **（仅当启用向量检索时）** embedding 服务的维度与库中向量维度是否一致——最容易踩的坑：
   换了 embedding 模型导致维度不匹配，写入时静默失败。v1 默认不做向量（见 §3.5），该检查
   只在开启向量时生效

第 5 点若启用向量则尤其重要——**维度不一致必须显式报错**，不能等到写入失败才发现。

✅  产品经理决策点: 维度需要用户在配置页面进行配置 


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

> **决策点 D7**：v1 是否把向量设为「默认关、可选开」？（建议：是）


✅  产品经理决策点: 把向量设为「默认关、可选开」;再增加一个设置, 数据库里面可能会存多个workSpace的事实向量, 要求增加一个配置, 是否跨workspace查询 
或者能指定到具体的workspace [V1不做]



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
    ├── commands.mjs        # 四个 /memory-pg-* 命令注册
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

> ⚠️ **待定**：`vector(1024)` 是占位、且只在开启向量后使用。实际维度取决于 embedding 模型
> （Ollama 常见 `nomic-embed-text`=768、`bge-m3`=1024）。v1 默认不依赖向量（§3.5）；
> 开启后**维度必须做成配置项并在连接测试时校验**（见 §2.2 ⑥）。

### 4.4 关键数据流：提炼与入库

```
用户输入 /memory-pg-save 保存这个bug的排查方案
  │
  ├─ 1. ctx.commands handler 被调用（不经过模型）
  ├─ 2. 取当前会话上下文（从 session 事件流，参考实现用 session/event 累积）
  ├─ 3. 走 ctx.llm.stream() 提炼 → 结构化事实 JSON    ⚠️ 见下
  ├─ 4. segment.mjs 分割 + 去重 + 冲突检测
  ├─ 5. store.mjs 写入 PG（JSON 事实行 + trigram 索引 + content_hash）
  │     └─ 可选：若「向量检索」开关开启 → embedding.mjs 批量向量化回填 embedding 列
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
| F-09 | `/memory-pg-save` | P0 | M3 |
| F-10 | `/memory-pg-search` | P0 | M3 |
| F-11 | `/memory-pg-load`（注入上下文） | P0 | M4 |
| F-12 | 向量写入 + 向量检索 + RRF 合并（可选，默认关） | P1 | M5 |
| F-13 | 模型可调用工具（`memory_search`） | P1 | M4 |
| F-14 | `/memory-pg-compact` → md 导出 | P1 | M5 |
| F-15 | 上下文压力触发的自动注入 | P1 | M5 |
| F-16 | 记忆管理：列表/编辑/软删除 | P1 | M5 |
| F-17 | AGE 图：实体关系与取代链 | P2 | M6 |
| F-18 | 记忆统计与调试视图 | P2 | M6 |

---

## 6. 里程碑

### M0 — 技术验证（🎯 最高优先级，1–2 天）

**目的：在写任何产品代码前，把 4 个高危假设打掉。** 详见 §7。

- [ ] 验证命令注册与 kebab-case 命令名可用（hello-world 命令）
- [ ] 验证 `ctx.llm.stream()` 在命令 handler 中的可用性（决策点 D4）
- [ ] 验证 PG + pgvector 在本机可跑通，HNSW 索引可用
- [ ] **验证 JSON+关键词+LLM 重排主路径**：用几个真实检索用例（同义复述 / 无关键词命中）
      对比「纯关键词」vs「关键词+重排」vs「向量」三条路线的召回质量 —— 决定 D7
- [ ] 验证「第二个隔离 DSH 实例」方案可行（§8）

**退出标准**：四个验证各有明确结论；D4、D7 有结论。

### M1 — 骨架与设置面板（P0）

- [ ] 仓库骨架 + `package.json` + `cordis.patch.yml`
- [ ] Node half 挂载成功（boot log 干净）
- [ ] 设置命名空间注册 + Client 卡片渲染
- [ ] 连接测试（分项报告）

**退出标准**：设置面板里能看到 `dsh_memory_pg`，填入参数点「连接测试」有正确分项结果。

### M2 — 存储层（P0）

- [ ] schema 迁移 + 连接池（含 trigram 扩展）
- [ ] `store.mjs` CRUD（含软删除）+ 关键词/元数据检索
- [ ] `rerank.mjs` LLM 重排（主路径）
- [ ] 单元测试（PG 一次性实例）

### M3 — 提炼与保存（P0）

- [ ] 提炼 prompt + 结构化输出容错解析
- [ ] 语义分割 + 去重 + 冲突检测（含单元测试）
- [ ] `/memory-pg-save` 与 `/memory-pg-search` 端到端可用

**退出标准**：`/memory-pg-save 保存这个bug的排查方案` → 库里出现可检索的记忆条目。

### M4 — 注入（P0）

- [ ] `recall.mjs` 注入决策 + 预算裁剪
- [ ] `/memory-pg-load`
- [ ] `memory_search` 工具

**退出标准**：新会话中能 load 出前一会话保存的记忆，并影响模型回答。

### M5 — 打磨（P1）

- [ ] md 导出、管理界面、压力自动注入
- [ ] 可选向量：embedding 客户端 + 维度校验 + 向量检索 + RRF 合并（F-05/F-12，默认关）

### M6 — AGE 图（P2，条件：D3 确认需要）

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

**约束**：现有 DSH 正在通过 `dsh web` 服务本会话（`http://127.0.0.1:3080`），且是**源码运行
的未发布 v0.1.3**。自测绝不能污染它。

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
> 这一条在 M0 验证。

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

不要依赖真实的 Ollama（不稳定、慢、维度不可控）。写一个 30 行的 Node HTTP server 返回
**确定性向量**（例如对文本做哈希种子生成），让测试可复现：

```
POST /v1/embeddings  →  { data: [{ embedding: [确定性向量] }] }
```

### 8.4 PG 测试环境

- **方式一（推荐）**：Docker 一次性容器
  ```powershell
  docker run --rm -d -p 55432:5432 -e POSTGRES_PASSWORD=test `
    pgvector/pgvector:pg17
  ```
  ⚠️ 需确认本机有 Docker；且 AGE 需要自定义镜像（又一个 AGE 的成本证据）。
- **方式二**：本机已有 PG，**新建独立 database**（如 `dsh_memory_pg_test`），测完 drop。

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
| R2 | AGE + 连接池的 `search_path` 问题 | 连接不稳定 | v1 不上 AGE（D3） |
| R3 | embedding 维度与库不一致（仅向量模式） | 写入静默失败 | 显式校验（§2.2 ⑥）；v1 默认不走向量，无此风险 |
| R4 | 提炼质量不稳定 / JSON 解析失败 | 记忆污染 | 容错解析 + 人工确认（参考实现已有模式） |
| R5 | 自动注入挤占上下文 | 反而加速溢出 | 严格注入预算 + 优先级排序 |
| R6 | kebab-case 命令名不被 composer 识别 | 需改名 | M0 实测 |
| R7 | 现有 DSH 被自测污染 | 影响你当前工作 | §8 隔离方案 |
| R8 | 与官方 compaction 冲突 | 注入被压缩覆盖 | 协同而非竞争（§2.2 ①） |
| R9 | 关键词检索召回差（同义/复述查不到） | 记忆「搜不到」 | M0 对比验证；LLM 重排补语义；必要时开向量（§3.5） |

---

## 11. 待决问题（需要你拍板）

| 编号 | 问题 | 建议 |
|---|---|---|
| **D1** | v1 做「显式注入」还是直接做「pressure 自动注入」？ | 先显式，v2 自动 |
| **D2** | md 导出是独立命令还是 `save` 的参数？ | `save` 的参数（`--md`） |
| **D3** | v1 是否真的需要 AGE？ | **不需要**，v2 再说 |
| **D4** | 提炼走 `ctx.llm.stream()` 还是独立 HTTP 端点？ | M0 spike 后定 |
| **D5** | 记忆的 `kind` 分类是否够用（fact/preference/decision/procedure）？ | 待你确认业务需要 |
| **D6** | 是否需要「记忆置顶/核心记忆」常驻注入？ | 参考实现有这个特性，建议保留 |
| **D7** | 检索主路径：JSON+关键词+LLM 重排，向量设为「默认关、可选开」？ | **是**（§3.5）；M0 对比验证后定 |

---

## 12. 下一步

1. **你确认 D1–D7**（尤其 D3、D4、D7——它们影响工作量最大）
2. 我执行 **M0 技术验证**，把高危假设打掉（含 D7 的检索路线对比）
3. M0 通过后，用 `writing-plans` 出**可执行的实施计划**，然后进入实现

> 本文档是**立项与规划**。进入实现前会产出独立的实施计划（分任务、可验证、带 TDD 步骤）。

---

## 附录：与参考实现的差异对照

| 维度 | `dsh-local-vector-memory` | `dsh_memory_pg`（本项目） |
|---|---|---|
| 存储 | SQLite（单文件） | **PostgreSQL** |
| 检索主路径 | 向量（内存暴力） | **JSON 事实行 + 关键词（trigram）+ LLM 重排**（§3.5） |
| 向量 | 必须（依赖 embedding 服务） | **可选、默认关**（pgvector + HNSW，F-12） |
| 图 | 无 | AGE（v2，待 D3） |
| 配置方式 | `cordis.patch.yml` 手写 | **设置面板 UI** + 连接测试 |
| 调用入口 | 自建工具 | **`/memory-pg-*` 命令** + 工具 |
| 提炼 | 独立 HTTP 端点（9B 本地模型） | ⚠️ 待定（D4），倾向 `ctx.llm` |
| 作用域 | 全局 | **workspace 隔离** |
| 注入 | `agent/pre-step` 自动召回 | 显式 `load` + 压力触发（v2） |
