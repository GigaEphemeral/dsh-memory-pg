# 提炼能力改造方案：对齐系统 /compact（问题3）

> 状态：**方案稿，未动手**（用户 2026-09-14 指示：先了解、出方案，不急着改）。
> 对比素材：`排查用勿提交/系统compact比较/compact生成.txt`（系统 /compact 输出）vs `memory-pg-compacts生成*.md`（我们的输出）。

## 1. 差距诊断：系统 /compact 为什么"更像项目记忆"

| 维度 | 系统 /compact | dsh-memory-pg（当前） |
|---|---|---|
| 输出形态 | **8 节结构化 Markdown 检查点**：Primary Request and Intent / Key Technical Concepts / Files and Code / Errors and Fixes / Pending Jobs / Current Work / Next Step / Critical Context | **扁平原子事实列表**（每条一行 content + tags） |
| 意图捕获 | ✅ 逐条记录**用户请求的演变**（"User then instructed…"、"Follow-ups in order…"、"Main current ask…"） | ❌ 事实化后丢失"用户想要什么、需求如何演变"的叙事 |
| 上下文导航 | ✅ 分节，未来会话可**按节定位**（看 Pending Jobs 就知道还有什么没做） | ❌ 无章节，靠检索猜 |
| 精确性 | ✅ 保留路径/命令/错误串/数值/标识符（D-M3-2 已吸收的纪律在系统侧是完整的） | ⚠️ 纪律已吸收，但**无章节框架约束**，模型自由发挥 |
| 结构深度 | ✅ Key Technical Concepts 是**概念清单**，Critical Context 是**决策+理由** | ⚠️ 事实粒度参差：有的记环境变量，有的记命令行为，无优先级分层 |
| 待办/下一步 | ✅ **显式** Pending Jobs / Next Step | ❌ 无此维度——这是"换会话能无缝继续"的关键，我们缺了 |

**一句话结论**：我们的问题不是"没吸收 prompt 纪律"，而是**输出结构是扁平事实，缺少系统的 8 节叙事框架**——特别是"用户意图演变 + 待办 + 下一步"这三节，正是"让另一个会话无缝继续"的核心。用户看到的系统 compact 之所以像"项目相关记忆"，是因为它回答了"项目是什么、进展到哪、下一步做什么"，而我们只回答了"有哪些事实碎片"。

## 2. 保留什么、改什么（对齐原则）

用户此前（D-M3-2）要求"不照搬官方机制，只吸收 prompt 纪律"；现在用户基于实测反馈"按系统 /compact 改造"——**两者不冲突**，我们做的是：**吸收系统的 8 节框架作为提炼输出结构，保留我们的事实库底座（facts 可检索/去重/冲突检测）**。

- **保留**：facts 三要素模型（subject/predicate/object）、content_hash 去重、软删除/取代链、关键词检索、PG 存储。
- **改造 A（提炼 prompt）**：`DISTILL_SYSTEM_PROMPT` 从"输出扁平 JSON facts"改为"输出**结构化检查点 JSON**"——每个 fact 带 `section` 字段（8 节之一），LLM 按节提炼。
- **改造 B（存储）**：facts 表加 `section` 列（或复用 kind 字段），按节打标；`/memory-pg-compact` 生成的 md 按 8 节渲染（对齐系统输出观感）。
- **改造 C（检索）**：`/memory-pg-search` 结果按 section 分组展示；`/memory-pg-load`（M4）注入时按"意图/待办/下一步"优先注入。
- **不动**：分段/去重/重排算法、命令框架、连接状态机（上轮刚修的）。

## 3. 改造后提炼 prompt 草案（对齐系统的 COMPACTION_INSTRUCTION）

```
你是长期记忆提炼器。把上面的对话总结成一个结构化检查点，让另一个会话能无缝继续。

按以下 8 节输出（每节下用简洁条目，没有的内容写"(无)"，不要省略节）：
1. 用户请求与意图（Primary Request and Intent）：用户最初要什么、中途如何修改、最新的要求——按时间顺序记录，精确引用关键措辞
2. 关键技术概念（Key Technical Concepts）：技术栈、模式、约定、关键参数（路径/命令/错误串/标识符/数值原样保留）
3. 文件与代码（Files and Code）：精确路径 + 为什么重要 + 关键改动/片段
4. 错误与修复（Errors and Fixes）：错误现象 + 如何解决 + 相关用户反馈
5. 待办（Pending Jobs）：明确提出但未完成的工作
6. 当前工作（Current Work）：最近在做什么、进行到哪一步
7. 下一步（Next Step）：紧接着该做的单一动作（直接呼应最近请求）
8. 关键上下文（Critical Context）：决策及理由、约束、用户偏好、开放问题、继续所需数据

只输出 JSON：{"facts":[{"section":1,"subject":"...","predicate":"...","object":"...","content":"完整陈述","tags":[...]}]}
content 是完整句子；不要 Markdown、不要解释；没有值得记的就输出 {"facts":[]}。
```

要点：**section 序号 = 8 节之一**，把"叙事框架"编码进每条事实，同时保持 facts 表可检索。

## 4. 里程碑与验证

- **M3.5（本次改造）**：prompt 改 8 节 + facts.section 列（迁移 SQL 幂等 ALTER）+ compact md 按节渲染 + search 按节分组。单测：distill 断言输出含 section 字段、8 节齐全性。
- **验证**：同一段会话分别跑系统 /compact 和我们的改造版，人工对比 8 节覆盖度；用户确认"更像项目记忆"后再进 M4（注入）。

## 5. 待确认问题

1. **md 文件格式**：compact 输出的 md 按 8 节 Markdown（对齐系统观感）还是保留当前"## N. 事实"列表 + 节标签？建议前者（用户认可系统观感）。
2. **facts.section**：加列 vs 复用现有 `kind` 字段（当前默认 'fact'）？建议加列（kind 语义已定，避免混用）。
3. **搜索注入权重**（M4 时）：是否"意图/待办/下一步"三节优先注入？建议是。
