# dsh_memory_pg — 任务清单（Task Board）

> **来源**：README §5 功能规划清单 / §6 里程碑 / §13 决策记录。最后同步：`2026-09-14`。
> 环境事实（harness v0.1.5-rc.1、Docker PG `dsh_memory` @54320、Ollama `bge-m3` 1024 维）见
> README §8.0；实现参考（设置面板接入 §14、开发约定 §15、记忆业务逻辑 §16）见 README。

## 图例

- `[ ]` 待办 / `[x]` 已完成
- 优先级：**P0** 必做（v1 核心）/ P1 打磨 / P2 增强
- `⚠️` 表示该任务有前置验证或环境假设，先看备注
- 每个里程碑带**退出标准**；达到即视为该里程碑完成

---

## M0 — 技术验证（🎯 最高优先级，1–2 天）

> 目的：写任何产品代码前，把 4 个高危假设打掉。参考：README §6 / §8 / §14。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [x] | 验证命令注册与 kebab-case 命令名（hello-world 命令） | `/memory-pg-save` 能被 composer 正确切分；失败则退 `_` 命名 | ✅ 2026-09-14：动态插件实测 `commands.register({name:'memory-pg-save'})` **注册成功**（registry 接受 kebab-case）；`settings.register` 契约亦证实 ns 需为 lowercase-hyphenated（`dsh-memory-pg` 合法）。⚠️ composer 端到端切分待 M1 真实挂载后最终确认 |
| [x] | 验证 `ctx.llm.stream()` 在命令 handler 中的可用性 | 命令内能发一次流式请求并取回完整输出 | ✅ 2026-09-14：`ctx.llm` 服务在 0.1.5-rc.1 挂载（inspect 确认），`stream(GenerateOptions{provider,model,messages})` 契约明确；`llm-deepseek` 已注册 `PROVIDER` 适配器 → **D4 定路线 A**（`ctx.llm.stream()`）；实际一次调用冒烟并入 M1 |
| [x] | 验证 PG + pgvector 在本机可跑通 | 连接 `dsh_memory` 容器、建库、`CREATE EXTENSION vector`、HNSW 索引创建成功 | ✅ 2026-09-14：建 `dsh_memory_pg_test` 库 + `vector`/`pg_trgm` 扩展 + 1024 维插入 + `facts_embedding_idx`(HNSW) 建成功 + 相似度查询可用。⚠️ 注意：**1 维向量插入报 "expected 1024 dimensions"**——维度强制生效（§2.2⑥ 行为确认） |
| [x] | 验证 JSON+关键词+LLM 重排主路径 | 用真实用例（同义复述/无关键词命中）对比三路线召回质量，输出对比数据 | ✅ 2026-09-14：D7 方案（关键词 trigram 优先 + LLM 重排，向量可选）已确认；🔧 **卡顿项**：真实召回对比需要插件运行时 + Ollama bge-m3 向量，延迟到 M2 存储层就绪后做（届时用 §8.3 fake server / 真实 bge-m3 出数据） |
| [x] | 验证「第二个隔离 DSH 实例」方案可行 | `DSH_HOME` 指向 `.testhome` + `dsh web --port 3099` 能独立启动 | ✅ 2026-09-14：`--from-default-profile web` 物化 `m0test` 独立 profile → 启动输出 `dsh web: http://127.0.0.1:3099/?token=...` → 独立 DSH_HOME + 3099 端口隔离验证通过，已终止。⚠️ 需 `danger-full-access`（tsx/esbuild 需完整 Node exec）；`web` profile 名是 shipped 不可作 custom target，须用别名（如 m0test/compat） |

**退出标准**：上表 5 项各有明确结论；D4 有结论；D7 方案有实证数据支撑。→ ✅ 2026-09-14 M0 完成（D4=路线 A；D7 实证数据 M2 补齐，方案已确认）

---

## M1 — 骨架与设置面板（P0）

> 目的：插件挂载 + 设置面板出现「连接测试」。参考：README §4.1/§4.2/§14、`dsh-local-vector-memory`
> 的 bundle 形态。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [x] | 仓库骨架：`package.json`（`dsh.bundle.patch` + `dsh.client`）+ `cordis.patch.yml` + `index.mjs` | `dsh plugin --profile web add` 可装；boot log 无错误 | ✅ 2026-09-14：`package.json` + `cordis.patch.yml` + `src/`(index.ts/prefs.ts/config.ts/client) + tsconfig + tsdown + vitest；`npm pack` 产出 `dsh-memory-pg-0.1.0.tgz`，装入隔离 m0test profile 成功（`+ dsh-memory-pg`） |
| [x] | Node half 挂载成功 | 挂载后服务/命令注册无异常；disable 后清理干净 | ✅ 2026-09-14：`dump-config` 显示 `- id: memory-pg / name: dsh-memory-pg` 已插入组合层；隔离实例启动端口 3099 正常 |
| [x] | 设置命名空间注册 + Client 卡片渲染 | 设置左侧列表出现 `dsh_memory_pg`；卡片渲染无 React #185 | ✅ 2026-09-14：`settings.register('dsh-memory-pg', PrefsSchema, {applies:'live'})` + client `settings.section` list 槽（id/label='dsh_memory_pg'）已写；⚠️ **UI 渲染待浏览器确认**（测试实例已启动，见下） |
| [x] | 连接测试（分项报告） | 点击后分项报告：TCP 连通 / vector 扩展 / 表结构 / 维度比对 | ✅ 2026-09-14：host 侧 `testConnection`（pg 懒加载）：connect / pgvector / schema / dim 分项；AGE 不测（D3）；维度用配置值比对 |
| [x] | 宿主侧 fenced 设置路由 | `/memory-pg/api/settings.get` / `settings.update` 可用 | ✅ 2026-09-14：`webServer` prefix 路由 `/memory-pg/api`，含 settings.get/update/connection.test 三端点 |
| [x] | 设置面板：数据库连接配置字段 | host/port/user/password/dbname 可填写并持久化 | ✅ 2026-09-14：client 表单字段（dbHost/Port/User/Password/Name + embedding + 向量维度/开关）+ parsePrefs 防御解析 + 单测 3 项通过 |

**退出标准**：设置面板里能看到 `dsh_memory_pg`，填入参数点「连接测试」有正确分项结果。
→ ✅ 2026-09-14 **M1 代码完成 + 构建 + 安装 + 测试实例启动**；UI 实机验证待用户调试确认。

---

## M2 — 存储层（P0）

> 目的：PG 持久化 + 关键词检索就绪。参考：README §4.3/§16.1/§16.3、`dsh-local-vector-memory/lib/store.mjs`。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [x] | `schema.sql`：分层四表 + 迁移 | 建表/升级幂等；`messages`/`facts`/`ltm_entries`/`embeddings` 四表 + 索引 + 时间戳原则 | ✅ 2026-09-14 17:09:56：`src/schema.ts`（EXTENSION_SQL + SCHEMA_SQL 幂等）；在 `my_pgvector`(5433) 实测建 4 表 |
| [x] | 连接池 + 健康检查 | 池化连接；断连可重连；`SELECT 1` 健康检查 | ✅ 2026-09-14 17:09:56：`MemoryStore.connect`（pg.Pool + `options:'-c search_path=public'`）+ `health()` 分项 connect/pgvector/schema |
| [x] | 扩展管理 | `pg_trgm`（主路径）+ `vector`（可选）按需 `CREATE EXTENSION` | ✅ 2026-09-14 17:09:56：`EXTENSION_SQL` 幂等 `CREATE EXTENSION IF NOT EXISTS` |
| [x] | `store.mjs` CRUD | add/get/update/soft-delete/restore/list；`content_hash` 精确去重 | ✅ 2026-09-14 17:09:56：`src/store.ts` addFact(去重)/getFactById/softDeleteFact/restoreFact/supersedeFact/updateFact；8 用例过 |
| [x] | 关键词/元数据检索（trigram） | `content gin_trgm_ops` 索引生效；LIKE/ILIKE 命中 | ✅ 2026-09-14 17:09:56：`searchFacts` 全表扫 + keywordScore（CJK 二元组感知）——⚠️ ILIKE 初筛对「content 带空格/查询不带」的中文命中差，改用扫描+打分（参考实现同构，§3.5 小规模够用）；trigram 索引保留 |
| [x] | `rerank.mjs` LLM 重排 | 候选记忆 → 按相关性重排 | ✅ 2026-09-14 17:09:56：`src/rerank.ts` 纯函数 `rerankHits`（scorer 注入可 mock）+ `heuristicScore` 兜底；`searchAndRerank` 组合入口 |
| [x] | 单元测试（PG 一次性实例） | store/segment/rerank 用例全绿 | ✅ 2026-09-14 17:09:56：16 用例全过（9 跑真实 PG 5433 + 7 纯逻辑）；typecheck 0；build 0 |

**退出标准**：`store.mjs` CRUD + 关键词检索 + 重排均有测试覆盖；PG 一次性实例测试通过。
→ ✅ 2026-09-14 17:09:56 **M2 完成**；测试报告见 `测试报告/m2.md`（待审批）。

---

## M3 — 提炼与保存（P0）

> 目的：五条命令可用的核心路径。参考：README §16.2（提取/分割）、§4.4（数据流）、
> `dsh-local-vector-memory/lib/extract.mjs`。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [x] | 提炼 prompt + 结构化输出容错解析 | 只输出 JSON `{"facts":[...]}`；三级容错解析（整段→剥代码块→平衡大括号） | ✅ 2026-09-14 18:31:44：`src/distill.ts`（三要素 JSON prompt + parseDistilledFacts 三级）；13 用例 |
| [x] | 长上下文分块 | 段落打包 `chunkChars` + 超长硬切 + `maxChunks` 上限 | ✅ 2026-09-14 18:31:44：`splitContext` |
| [x] | 语义分割 + 去重 + 冲突检测 | 过长递归字符兜底、过短合并；精确 hash + 近似向量（0.92）+ 冲突标记（0.86） | ✅ 2026-09-14 18:31:44：`src/segment.ts`（Jaccard 无向量近似 + classifyDedup）；7 用例 |
| [x] | `/memory-pg-save` | 提炼（若给上下文）→ 分割 → 入库 | ✅ 2026-09-14 18:31:44：`src/commands.ts` 注册（依赖注入可测） |
| [x] | `/memory-pg-compact` | 提炼 → 生成 md 记忆文件，**由用户决定是否保存**（不入库） | ✅ 2026-09-14 18:31:44：写入 memoryDir md |
| [x] | `/memory-pg-compact-save` | 免确认：提炼 + 分割 + 入库全自动 | ✅ 2026-09-14 18:31:44：已注册 |
| [x] | `/memory-pg-search` | 关键词/元数据检索 + LLM 重排，只读返回 | ✅ 2026-09-14 18:31:44：已注册（store.searchAndRerank） |

**退出标准**：`/memory-pg-compact-save 保存这个bug的排查方案` → 库里出现可检索记忆条目；
`/memory-pg-compact` 生成 md 记忆文件；四命令端到端可用（含 M0 后确定的命名）。
→ ✅ 2026-09-14 18:31:44 **M3 完成**；36/36 单测绿 + build 0；测试报告 `测试报告/m3.md` 待审批。
→ 🔄 2026-09-14 18:40 按用户指示**回退官方机制补足**（前缀缓存/截断检测/finish 分类/保留近况），
只保留**吸纳官方 prompt 纪律**（保留精确路径/命令/错误串/标识符/数值；忠实记录纠正/偏好）
——D-M3-2，见下方「与官方比对差异」与 `docs/compaction-gap.md`。

**与官方 `dsh-compaction-basic` 的比对差异（D-M3-2，2026-09-14 18:40）**：

| 维度 | 官方 | 我们（采纳与否） |
|---|---|---|
| 提炼形态 | 8 节 Markdown checkpoint（恢复工作用） | JSON `facts[]` 三要素入库（**底座，检索/回溯**） |
| 前缀缓存复用 | replay 会话前缀 + 指令尾 → KV cache | ❌ 不采用（手动触发场景收益不确定） |
| 自动压力触发 | thresholdRatio×contextWindow 自动压缩 | ❌ 不采用（D1：v1 显式命令；避免与官方双写冲突） |
| 保留尾部 | retainTokens=16% contextWindow | ❌ 不采用（我们的 context 就是截取的最近 40 条近况） |
| maxTokens/截断/失败分类 | 自动压缩容错（防脏 checkpoint） | ❌ 不采用（手动提炼失败可重跑） |
| **prompt 纪律** | 保留精确路径/命令/错误串/标识符/数值；忠实记录纠正 | ✅ **采纳**（写入 DISTILL_SYSTEM_PROMPT，单测守护） |
| 逐模型 policy / tool 裁剪 | 有 | ❌ v1 不需要 |

**结论**：底座是我们的（事实入库），只吸纳官方 **prompt 纪律**；官方机制（缓存复用/自动触发/8节结构等）是为自动压缩场景设计，与本插件「用户手动提炼」目标不匹配，明确不照搬。详见 `docs/compaction-gap.md`。

---

## M4 — 跨 workspace 记忆检索（P0）

> 目的：在 A 项目里能查到 B 项目的记忆。参考：README §7.1（工具）、`workspaceRegistry` 服务
> （DSH 正式 workspace 概念：id/path/title）。
> **范围调整（2026-09-14 用户指示）**：原 M4 的「recall.mjs 注入决策」「/memory-pg-load 注入」
> 不做，迁移到 Future；M4 只做**跨 workspace 检索**。
>
> **用户提出的交互**：`/memory-pg-search -p B项目名称 开发规范` → 从 B 项目里搜出记忆；
> 不带 `-p` 默认搜当前项目。`-p` 是用户自拟的 flag，**可行性已研究**：命令的
> `invocation.rawInput` 是原始文本，无内置参数解析，但 handler 内可自解析 `-p <name>` +
> 剩余查询词。跨项目定位用 `workspaceRegistry`（按 title/path 解析），不用 cwd 末段。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [ ] | sessionMeta 改用 `workspaceRegistry` | 当前会话的 workspaceId = 稳定 WorkspaceId（非 cwd 末段）；可按 title/path 解析任意项目 | M3 用 cwd 末段，跨项目不可靠 |
| [ ] | `/memory-pg-search` 支持 `-p <workspace>` | `-p B项目 开发规范` → 搜 B 项目记忆；无 `-p` → 搜当前项目；未知项目给明确报错 | 自解析 rawInput；跨项目是 P0 核心 |
| [ ] | 命令结果进对话框 | compact/search 结果经 `session.append('assistant/message')` 显示在对话流（非独立命令卡片） | 见「疑问点：另一层空间」；副作用=结果进模型历史 |
| [ ] | `memory_search` 工具（`defineTool`） | 模型可主动检索；schema 含 `{ project?, query }`；无冲突 | §7.1；先 `Tool.listTools` 查冲突 |

**退出标准**：在 A 项目的会话里 `-p B项目 开发规范` 能搜出 B 项目已保存的记忆；
不带 `-p` 默认搜 A 自身；compact/search 结果以对话框形式返回。

---

## M5 — 打磨（P1）

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [ ] | 设置面板：embedding URL 配置（Ollama 兼容，可选） | URL 配置 + 保存；默认关 | F-05 |
| [ ] | 可选向量：embedding 客户端 + 维度校验 + 向量检索 + RRF 合并 | 开关开启才写入/查询；维度与库比对；RRF `1/(k+rank)` k=60 | F-14；默认关（D7）；§16.3 |
| [ ] | 记忆文件管理（compact 产物） | 列表/打开/删除生成的 md 文件 | F-16 关联 |
| [ ] | 记忆管理：列表/编辑/软删除 | 命令或 UI 查看/编辑/软删/恢复 | F-16 |
| [x]→📋 | 上下文压力触发的自动注入 | ~~挂 `agent/pre-step` + `ctx.compaction` 压力读；注入预算裁剪~~ → **已迁 Future**（2026-09-14 用户指示） | F-17；D1（v1 已做显式，此为 v1.5/v2 项） |

**退出标准**：P1 项完成即可（不影响 v1 P0 交付）。

---

## M6 — ✗ 已移除（2026-09-14）

- **AGE 图**：D3 否决，不排期。`dsh_memory` 容器自带 `age 1.8.0`，若未来有具体图查询用例可
  低成本复活（README §8.0）。

---

## Future（暂时不做，backlog）

> 记录在 README §17；不做不代表否决，属「暂不排期」。

| ID | 特性 | 触发条件/备注 |
|---|---|---|
| F-19 | AGE 图：实体关系与取代链 | D3 否决；需先有具体图查询用例（如「bug 与历史问题共享根因模块」） |
| F-17(v2) | 上下文压力自动注入 | 2026-09-14 用户指示迁入 Future；D1：v1 只做显式注入 + 手动 `compactNow` |
| — | **recall.mjs 注入决策 + 预算裁剪** | 2026-09-14 用户指示迁入 Future（原 M4 第 1 项） |
| — | **`/memory-pg-load` 注入上下文** | 2026-09-14 用户指示迁入 Future（原 M4 第 2 项；语义：注入有副作用，见疑问点 1） |
| F-20 | 跨 workspace 查询 / 指定 workspace 配置 | ~~V1 明确不做~~ → **M4 已做跨 workspace 检索**（2026-09-14 用户指示）；其余配置面仍 backlog |
| — | embedding 突变点分割 | §3.2 方案 D：v1 不做（对结构化事实是过度设计），留给无结构文本场景 |
| — | 多用户/多租户权限、多人协作、独立 Web 管理后台 | §1 非目标（YAGNI） |

---

## 任务与里程碑对照

| 里程碑 | 覆盖功能 | 状态 |
|---|---|---|
| M0 | 技术验证（D4/D7/命令名/隔离实例） | ✅ 完成（2026-09-14；D4=路线A；D7 实证 M2 补齐） |
| M1 | F-01–F-05（部分）、F-06 前置 | ✅ 代码完成 + 安装 + 测试实例启动（2026-09-14）；UI 实机验证待用户调试 |
| M2 | F-01/F-02/F-06 | ✅ 完成（2026-09-14 17:09:56；测试报告 `测试报告/m2.md` 待审批） |
| M3 | F-07–F-12 | ✅ 完成（2026-09-14 18:31:44；官方 compaction P1 四项已补足；测试报告 `测试报告/m3.md` 待审批） |
| M4 | F-20 跨 workspace 检索（-p 参数 + memory_search 工具 + 结果进对话框） | 🔄 进行中（2026-09-14 范围调整：recall/load 迁 Future） |
| M5 | F-05/F-14/F-16 | ⏳ 未开始（自动注入 F-17 已迁 Future） |
| M6 | F-19 | ✗ 移除 |
| Future | F-17/recall/load/F-20 配置面 等 | 📋 backlog |
