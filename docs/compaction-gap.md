# 与官方 dsh-compaction-basic 的差距分析与补足方案

> 生成时间：2026-09-14 18:20:00
> 对照基准：`@deepseek-ai/dsh-compaction-basic`（0.1.5-rc.1，`packages/compaction/compaction-basic/src/`）
> 对象：本插件 `src/distill.ts` / `src/commands.ts` 的上下文提炼路径

---

## 1. 差距总览

| # | 维度 | 官方 compaction-basic | 我们当前（M3 distill.ts） | 差距 | 优先级 |
|---|---|---|---|---|---|
| 1 | **提炼 prompt 形态** | 结构化 Markdown checkpoint（8 节：Primary Request / Key Concepts / Files / Errors / Pending / Current Work / Next Step / Critical Context），**保留精确路径/命令/错误串/标识符/数值** | JSON `facts[]` 三要素数组（subject/predicate/object/tags） | 我们面向**事实入库**（facts 表），官方面向**恢复工作的 checkpoint**——形态差异合理；但我们的 prompt **缺"保留精确标识符/数值"的强约束** | 高 |
| 2 | **前缀缓存复用** | 指令作为**最后一条 user 消息**追加在 replay 的会话前缀后，provider 的 **KV cache 复用**（aux 调用是上轮请求的真前缀） | 只发 `system + user`，**不 replay 会话前缀** → KV cache 无效化，多花 tokens | **大差距**：每次提炼都重新算前缀 | 高 |
| 3 | **压力触发** | `thresholdRatio=0.8` × contextWindow，tokenMeter 计量，自动在 `agent/pre-step` 触发；context-overflow 后重试 | 仅手动命令触发（/save /compact-save），无压力计量 | 我们 v1 明确**只做显式命令**（D1），自动触发是 v2——但**溢出重试缺失**应立即补 | 中 |
| 4 | **保留尾部** | 只压缩最旧历史，保留最近 `retainTokens`（=16% contextWindow） | 无保留概念（全上下文喂给提炼） | **中差距**：我们应支持"保留最近 N 条不参与提炼" | 高 |
| 5 | **maxTokens + 截断检测** | `maxTokens=8192` 默认；finish=max-tokens 时**fail-closed**（报 MAX_TOKENS，不用截断残稿） | 无 maxTokens；不检测截断 | 中差距 | 高 |
| 6 | **逐模型 policy** | `modelPolicies[]` 按 provider/model 覆盖阈值/保留/maxTokens | 无 | 低（v1 单模型够用，M5 再说） | 低 |
| 7 | **失败分类** | finish 分类：error/aborted/max-tokens → 明确错误 | distill caller 直接 throw，无分类 | 中 | 中 |
| 8 | **tool-result 预裁剪** | 可选 `tool-result-pruner` 先裁超大工具输出 | 无 | 低（v1 可省） | 低 |

## 2. 我们的自身优化点（官方没有的）

| # | 优化点 | 说明 |
|---|---|---|
| O1 | **事实入库 + 检索** | 官方只产出 checkpoint 文本丢弃；我们提炼后进 `facts` 表，可检索/注入——这是本插件的核心差异价值 |
| O2 | **三要素结构化 + 分层标签** | 官方 flat markdown；我们 facts 表三要素 + tags（`['编程','编程-java']` 层级过滤） |
| O3 | **去重/冲突链** | 我们 segment.classifyDedup：精确 hash + 近似（0.92/0.86）+ superseded 取代链；官方无 |
| O4 | **软删除/恢复/管理** | store CRUD + 软删/恢复/统计；官方一次性 |
| O5 | **多出口** | /compact 生成 md 文件、/save 入库、/compact-save 免确认——官方只有 /compact 落 checkpoint |

## 3. 补足方案（按优先级落地到 M3/M4）

### P1 立即可补（M3 收尾）

1. **前缀缓存复用（差距 2）**：distill caller 从"只发 system+user"改为——若有会话前缀（最近 K 条消息 replay），把提炼指令作为**最后 user 消息**，前缀排在前面 → KV cache 复用。实现：`contextProvider` 已返回最近 40 条，distill caller 重组 messages：`[...replayed, {user: 指令}]`。
2. **保留尾部（差距 4）**：distill 增加 `retainLast: number`（默认 8 条），`contextProvider` 只把**前面的**历史给提炼，最近 8 条原样保留在会话（不参与提炼）。官方是 token 比例；我们先用**条数**近似（v1 简单、可测）。
3. **maxTokens + 截断检测（差距 5）**：distill caller 设置 `maxTokens`（默认 2000），收集 finish reason；max-tokens → 抛明确错误，**不用截断残稿**。
4. **失败分类（差距 7）**：distill caller 按 finish kind 抛 `error/aborted/max-tokens` 分类错误。

### P2 M4/M5 补

5. **溢出重试（差距 3 的 overflow 部分）**：提炼请求 context-overflow 时，减半输入重试一次（仿官方 maxOverflowRetries）。
6. **逐模型 policy（差距 6）**：设置面板加 modelPolicies 表（M5）。
7. **tool-result 预裁剪（差距 8）**：提炼前裁剪超大 tool 输出（M5，或复用官方 pruner）。

## 4. 结论

我们的提炼**形态（事实入库）与官方本质不同且更有价值**（O1-O5），但**工程质量缺官方几项关键保障**：前缀缓存复用（省钱）、保留尾部（不丢近况）、maxTokens+截断检测（不吞脏稿）、失败分类。**P1 四项在 M3 收尾立即补足**；自动压力触发维持 v2（D1 已定），但溢出重试 P2 并入。

> 决策记录：D-M3-1（补足范围）见 `开发经验.md`。
