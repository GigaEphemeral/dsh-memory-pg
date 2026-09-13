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
| [ ] | 验证命令注册与 kebab-case 命令名（hello-world 命令） | `/memory-pg-save` 能被 composer 正确切分；失败则退 `_` 命名 | ⚠️ 命令契约：小写无斜杠（README §9），连字符**未承诺** |
| [ ] | 验证 `ctx.llm.stream()` 在命令 handler 中的可用性 | 命令内能发一次流式请求并取回完整输出 | ⚠️ 决策点 D4：路线 A 可行则定 A；不可行退路线 B（独立 HTTP 端点） |
| [ ] | 验证 PG + pgvector 在本机可跑通 | 连接 `dsh_memory` 容器、建库、`CREATE EXTENSION vector`、HNSW 索引创建成功 | 现成容器：`localhost:54320`，`postgres`/`czq`（README §8.0/§8.4） |
| [ ] | 验证 JSON+关键词+LLM 重排主路径 | 用真实用例（同义复述/无关键词命中）对比三路线召回质量，输出对比数据 | 为 D7 已确认方案提供实证 |
| [ ] | 验证「第二个隔离 DSH 实例」方案可行 | `DSH_HOME` 指向 `.testhome` + `dsh web --port 3099` 能独立启动 | ⚠️ `--port` 参数名以 0.1.5-rc.1 的 CLI 为准 |

**退出标准**：上表 5 项各有明确结论；D4 有结论；D7 方案有实证数据支撑。

---

## M1 — 骨架与设置面板（P0）

> 目的：插件挂载 + 设置面板出现「连接测试」。参考：README §4.1/§4.2/§14、`dsh-local-vector-memory`
> 的 bundle 形态。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [ ] | 仓库骨架：`package.json`（`dsh.bundle.patch` + `dsh.client`）+ `cordis.patch.yml` + `index.mjs` | `dsh plugin --profile web add` 可装；boot log 无错误 | 形态：bundle 插件，重启生效（README §4.1） |
| [ ] | Node half 挂载成功 | 挂载后服务/命令注册无异常；disable 后清理干净 | 参考 §15.3 仓库纪律（禁改 DSH 源码、依赖不含 `cordis`） |
| [ ] | 设置命名空间注册 + Client 卡片渲染 | 设置左侧列表出现 `dsh_memory_pg`；卡片渲染无 React #185 | 用 `settings.section` 槽（§14.3）；快照引用稳定 |
| [ ] | 连接测试（分项报告） | 点击后分项报告：TCP 连通 / vector 扩展 / 表结构 / 维度比对 | ⚠️ AGE 项**不测试**（D3）；维度用配置页填写值（§2.2 ⑥） |
| [ ] | 宿主侧 fenced 设置路由 | `/memory-pg/api/settings.get` / `settings.update` 可用 | ⚠️ settings RPC 只服务白名单 ns，必须自建路由（§14.2） |
| [ ] | 设置面板：数据库连接配置字段 | host/port/user/password/dbname 可填写并持久化 | 存 `pluginSettings` 开放 map（§14.4） |

**退出标准**：设置面板里能看到 `dsh_memory_pg`，填入参数点「连接测试」有正确分项结果。

---

## M2 — 存储层（P0）

> 目的：PG 持久化 + 关键词检索就绪。参考：README §4.3/§16.1/§16.3、`dsh-local-vector-memory/lib/store.mjs`。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [ ] | `schema.sql`：分层四表 + 迁移 | 建表/升级幂等；`messages`/`facts`/`ltm_entries`/`embeddings` 四表 + 索引 + 时间戳原则 | 表结构见 README §4.3（分层四表 + 向量分离） |
| [ ] | 连接池 + 健康检查 | 池化连接；断连可重连；`SELECT 1` 健康检查 | |
| [ ] | 扩展管理 | `pg_trgm`（主路径）+ `vector`（可选）按需 `CREATE EXTENSION` | 每个测试库需各自启用（§8.4） |
| [ ] | `store.mjs` CRUD | add/get/update/soft-delete/restore/list；`content_hash` 精确去重 | 语义照搬 §16.1 |
| [ ] | 关键词/元数据检索（trigram） | `content gin_trgm_ops` 索引生效；LIKE/ILIKE 命中 | 主路径（§3.5/D7） |
| [ ] | `rerank.mjs` LLM 重排 | 候选记忆 → 按相关性重排 | 纯函数，可 mock LLM 测试 |
| [ ] | 单元测试（PG 一次性实例） | store/segment/rerank 用例全绿 | L1/L2 层，不需 DSH（§8.2） |

**退出标准**：`store.mjs` CRUD + 关键词检索 + 重排均有测试覆盖；PG 一次性实例测试通过。

---

## M3 — 提炼与保存（P0）

> 目的：五条命令可用的核心路径。参考：README §16.2（提取/分割）、§4.4（数据流）、
> `dsh-local-vector-memory/lib/extract.mjs`。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [ ] | 提炼 prompt + 结构化输出容错解析 | 只输出 JSON `{"memories":[{text,tags}]}`；三级容错解析（整段→剥代码块→平衡大括号） | 照搬 §16.2 prompt 纪律 |
| [ ] | 长上下文分块 | 段落打包 `chunkChars` + 超长硬切 + `maxChunks` 上限 | §16.2 |
| [ ] | 语义分割 + 去重 + 冲突检测 | 过长递归字符兜底、过短合并；精确 hash + 近似向量（0.92）+ 冲突标记（0.86） | §3.3/§3.4；含单元测试 |
| [ ] | `/memory-pg-save` | 提炼（若给上下文）→ 分割 → 入库 | 出口分流见 §4.4 |
| [ ] | `/memory-pg-compact` | 提炼 → 生成 md 记忆文件，**由用户决定是否保存**（不入库） | D2 |
| [ ] | `/memory-pg-compact-save` | 免确认：提炼 + 分割 + 入库全自动 | D2 |
| [ ] | `/memory-pg-search` | 关键词/元数据检索 + LLM 重排，只读返回 | 疑问点 1：只读 |

**退出标准**：`/memory-pg-compact-save 保存这个bug的排查方案` → 库里出现可检索记忆条目；
`/memory-pg-compact` 生成 md 记忆文件；四命令端到端可用（含 M0 后确定的命名）。

---

## M4 — 注入（P0）

> 目的：记忆重新注入上下文。参考：README §4.5、`dsh-local-vector-memory/index.mjs` 的
> `agent/pre-step` hook。

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [ ] | `recall.mjs` 注入决策 + 预算裁剪 | 按 workspace 检索高价值记忆；注入不超预算 | 纯函数可测 |
| [ ] | `/memory-pg-load` | 把本项目记忆整体注入当前上下文 | 语义：注入（有副作用），见疑问点 1 |
| [ ] | `memory_search` 工具（`defineTool`） | 模型可主动检索；schema 无冲突 | §7.1；先 `Tool.listTools` 查冲突 |

**退出标准**：新会话中能 `load` 出前一会话保存的记忆，并影响模型回答。

---

## M5 — 打磨（P1）

| 状态 | 任务 | 验收 | 备注 |
|---|---|---|---|
| [ ] | 设置面板：embedding URL 配置（Ollama 兼容，可选） | URL 配置 + 保存；默认关 | F-05 |
| [ ] | 可选向量：embedding 客户端 + 维度校验 + 向量检索 + RRF 合并 | 开关开启才写入/查询；维度与库比对；RRF `1/(k+rank)` k=60 | F-14；默认关（D7）；§16.3 |
| [ ] | 记忆文件管理（compact 产物） | 列表/打开/删除生成的 md 文件 | F-16 关联 |
| [ ] | 记忆管理：列表/编辑/软删除 | 命令或 UI 查看/编辑/软删/恢复 | F-16 |
| [ ] | 上下文压力触发的自动注入 | 挂 `agent/pre-step` + `ctx.compaction` 压力读；注入预算裁剪 | F-17；D1（v1 已做显式，此为 v1.5/v2 项，见 Future） |

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
| F-20 | 跨 workspace 查询 / 指定 workspace 配置 | V1 明确不做；数据库可能存多 workspace 向量时再评估 |
| F-17(v2) | 上下文压力自动注入 | D1：v1 只做显式注入 + 手动 `compactNow`；自动触发并入 v2 |
| — | embedding 突变点分割 | §3.2 方案 D：v1 不做（对结构化事实是过度设计），留给无结构文本场景 |
| — | 多用户/多租户权限、多人协作、独立 Web 管理后台 | §1 非目标（YAGNI） |

---

## 任务与里程碑对照

| 里程碑 | 覆盖功能 | 状态 |
|---|---|---|
| M0 | 技术验证（D4/D7/命令名/隔离实例） | ⏳ 未开始（最高优先） |
| M1 | F-01–F-05（部分）、F-06 前置 | ⏳ 未开始 |
| M2 | F-01/F-02/F-06 | ⏳ 未开始 |
| M3 | F-07–F-12 | ⏳ 未开始 |
| M4 | F-13/F-15 | ⏳ 未开始 |
| M5 | F-05/F-14/F-16/F-17 | ⏳ 未开始 |
| M6 | F-19 | ✗ 移除 |
| Future | F-20 等 | 📋 backlog |
