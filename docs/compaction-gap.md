# 与官方 dsh-compaction-basic 的差异分析与采纳策略

> 生成时间：2026-09-14 18:40:00（修订：D-M3-2 采纳策略调整后）
> 对照基准：`@deepseek-ai/dsh-compaction-basic`（0.1.5-rc.1，`packages/compaction/compaction-basic/src/`）
> 对象：本插件 `src/distill.ts` / `src/commands.ts` 的上下文提炼路径

---

## 0. 结论先行（D-M3-2）

**不照搬官方机制，只吸纳官方 prompt 纪律。**

- **底座是我们的**：三要素 JSON → facts 表（可检索/回溯/加载）——这是本插件的核心价值（最终目标 1/2/3）。
- **只吸纳官方的 prompt 纪律**：保留精确文件路径/命令/错误串/标识符/数值；忠实记录用户纠正与偏好。
- **明确不采用官方机制**：前缀缓存复用、自动压力触发、8 节 checkpoint 结构、maxTokens 截断检测、finish 分类、逐模型 policy、tool-result 预裁剪——这些是**官方自动压缩场景**的工程细节，与本插件「用户手动提炼」的目标不匹配（理由见 §4）。

---

## 1. 差距总览（纯分析，不构成采纳清单）

| # | 维度 | 官方 compaction-basic | 我们（M3 distill.ts） | 差距性质 |
|---|---|---|---|---|
| 1 | **提炼 prompt 形态** | 结构化 Markdown checkpoint（8 节）+ **保留精确路径/命令/错误串/标识符/数值** | JSON `facts[]` 三要素数组 | 形态不同（我们入库，官方 checkpoint）——**合理**；但 prompt 缺"保留精确内容"约束 → **采纳纪律** |
| 2 | **前缀缓存复用** | 指令作最后 user 消息 + replay 会话前缀 → KV cache 复用 | 只发 system+user | **不采用**（手动触发场景收益不确定，见 §4） |
| 3 | **压力触发** | thresholdRatio×contextWindow，tokenMeter，agent/pre-step 自动；overflow 重试 | 仅手动命令 | **不采用**（D1 定 v1 只做显式命令；官方已有自动压缩，避免双写冲突） |
| 4 | **保留尾部** | 保留最近 retainTokens=16% contextWindow | 无 | **不采用**（我们的 context 是"截取的最近 40 条"，本身就是近况） |
| 5 | **maxTokens + 截断检测** | maxTokens=8192；max-tokens fail-closed | 无 | **不采用**（手动提炼失败可重跑，无需残稿保护；后续如需要再加） |
| 6 | **逐模型 policy** | modelPolicies[] 覆盖阈值/保留/maxTokens | 无 | **不采用**（v1 单模型够用） |
| 7 | **失败分类** | finish 分类 error/aborted/max-tokens | caller 直接 throw | **不采用**（v1 简单 throw 够用；失败重跑即可） |
| 8 | **tool-result 预裁剪** | 可选 pruner 先裁超大工具输出 | 无 | **不采用**（v1 手动提炼场景用户自己控制输入规模） |

## 2. 我们的自身优化点（官方没有的，本插件核心）

| # | 优化点 | 说明 |
|---|---|---|
| O1 | **事实入库 + 检索** | 官方只产出 checkpoint 文本丢弃；我们提炼后进 `facts` 表，可检索/注入/加载——对应最终目标 1/2/3 |
| O2 | **三要素结构化 + 分层标签** | 官方 flat markdown；我们 facts 表三要素 + tags（`['编程','编程-java']` 层级过滤）——对应最终目标 2（跨项目回溯/检索） |
| O3 | **去重/冲突链** | segment.classifyDedup：精确 hash + 近似（0.92/0.86）+ superseded 取代链；官方无 |
| O4 | **软删除/恢复/管理** | store CRUD + 软删/恢复/统计；官方一次性 |
| O5 | **多出口** | /compact 生成 md 文件、/save 入库、/compact-save 免确认——官方只有 /compact 落 checkpoint |

## 3. 我们实际采纳（M3 已落地）

**只采纳官方 prompt 的 2 条纪律**（已写入 `src/distill.ts` 的 `DISTILL_SYSTEM_PROMPT`，有单测守护）：

1. **保留精确内容**：文件路径、命令、错误信息、标识符、数值、函数签名、语法片段原样保留，不改写。
   - 源自官方 `COMPACTION_INSTRUCTION`：*"Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments."*
2. **忠实记录用户反馈/纠正/偏好**：不遗漏、不美化。
   - 源自官方：*"Capture user feedback and explicit instructions faithfully, especially corrections."*

**不采纳**（见 §4 理由）：前缀缓存复用 / 自动压力触发 / 8 节结构 / maxTokens 检测 / finish 分类 / 逐模型 policy / tool-result 裁剪。

## 4. 为什么拒绝官方机制（决策依据）

| 机制 | 官方场景 | 我们的场景 | 拒绝理由 |
|---|---|---|---|
| 前缀缓存复用 | 自动压缩，提炼请求 = 会话延续，前缀重合度高 | 用户手动触发，时机随机、中间隔其他请求 | 缓存收益不确定；工程优化非功能；增加 caller 复杂度 |
| 自动压力触发 | 官方 agent loop 主干在压力时自动压缩 | 我们 v1 只做显式命令（D1）；官方已有压缩 | 双写冲突（README §2.2① 协同而非竞争）；v2 再评估，且应复用 ctx.compaction |
| 8 节 checkpoint 结构 | 让另一模型无缝恢复工作（checkpoint） | 我们入库检索（facts），不恢复对话 | 结构不匹配我们的数据模型 |
| maxTokens/失败分类 | 自动压缩容错（吞脏稿会污染 checkpoint） | 手动提炼失败可重跑 | 收益低；如后续需要可加 |

## 5. 后续可选（非照搬，按需评估）

- 若 v2 做自动注入：压力计量**复用官方 `ctx.tokenMeter` + `ctx.compaction`**，不重复造轮子（README §2.2①）。
- 若提炼频繁失败：再考虑加 maxTokens + finish 分类（届时是通用健壮性，非照搬）。

---

> 决策记录：D-M3-2（采纳策略）见 `开发经验.md`。
