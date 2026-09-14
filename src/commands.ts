/**
 * dsh-memory-pg 五条 /memory-pg-* 命令注册（M3）。
 *
 * 数据流（§4.4）：ctx.commands handler（不经模型）→ 取会话上下文 → distill → segment
 * → 按命令出口分流（save 入库 / compact 生成 md / compact-save 免确认全流程 / search 只读 / load 占位）。
 *
 * 依赖注入：handler 需要 store / distill caller / context provider / prefs getter，
 * 全部由 index.ts 注入（本模块可单测，传 stub）。
 */
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-commands'
import type { MemoryStore, FactRecord, SearchHit } from './store.ts'
import { distill, type DistilledFact, type LlmCaller, type LlmMessage } from './distill.ts'
import { segmentFacts, classifyDedup, type SegmentedFact } from './segment.ts'

/** 取当前会话上下文的提供者（index.ts 实现：读 session 事件流）。
 *  返回 { context, replayPrefix }：context 是待提炼文本（可含保留尾部处理），
 *  replayPrefix 是最近消息，replay 进 messages 头部以复用 provider KV cache。 */
export type ContextProvider = (agent: { id: string }) => Promise<{ context: string; replayPrefix?: Array<Pick<LlmMessage, 'role' | 'content'>> }>

/** 会话上下文来源的片段（供回溯）。 */
export interface CommandContext {
  workspaceId: string
  sessionId: string
  context: string
}

/** 会话元数据提供者（index.ts 注入：从 agent/session 解析 workspace）。 */
export type SessionMetaProvider = (agent: { id: string }) => Promise<{ workspaceId: string; sessionId: string }>

/** 命令依赖集合。 */
export interface CommandDeps {
  store: MemoryStore
  distillCaller: LlmCaller
  contextProvider: ContextProvider
  sessionMeta: SessionMetaProvider
  /** 记忆文件目录（compact 生成 md 用；index.ts 从配置读） */
  memoryDir: string
}

/** 解析 LLM 返回的三要素事实 → 入库。 */
async function persistFacts(
  store: MemoryStore,
  workspaceId: string,
  sessionId: string,
  facts: DistilledFact[],
): Promise<{ added: FactRecord[]; duplicates: number; conflicts: SegmentedFact[] }> {
  const segmented = segmentFacts(facts)
  const existing = await store.listExistingFacts(workspaceId)
  const classified = classifyDedup(segmented, existing)
  const added: FactRecord[] = []
  const conflicts: SegmentedFact[] = []
  let duplicates = 0
  for (const seg of classified) {
    if (seg.status === 'duplicate') { duplicates += 1; continue }
    if (seg.status === 'conflict') { conflicts.push(seg); continue }
    const rec = await store.addFact({
      workspaceId,
      sessionId,
      subject: seg.subject,
      predicate: seg.predicate,
      object: seg.object,
      content: seg.content,
      tags: seg.tags,
      importance: seg.importance,
      confidence: seg.confidence,
    })
    if (rec !== null) added.push(rec)
  }
  return { added, duplicates, conflicts }
}

/** 组装一条命令结果文本。 */
function summaryText(
  action: string,
  facts: DistilledFact[],
  res: { added: FactRecord[]; duplicates: number; conflicts: SegmentedFact[] },
): string {
  const lines = [
    `[memory-pg] ${action}: 提炼 ${facts.length} 条事实，新增 ${res.added.length} 条，重复跳过 ${res.duplicates} 条`,
  ]
  for (const f of facts) {
    lines.push(`- ${f.content}${f.tags.length ? ` [${f.tags.join(', ')}]` : ''}`)
  }
  if (res.conflicts.length > 0) {
    lines.push(`⚠️ ${res.conflicts.length} 条疑似与已有记忆冲突（待确认）：`)
    for (const c of res.conflicts) lines.push(`  - ${c.content}（与 fact#${c.conflictWith} 相似）`)
  }
  return lines.join('\n')
}

/** 注册五条命令。返回各注册的 disposer（由 apply 生命周期持有）。 */
export function registerMemoryCommands(ctx: Context, deps: CommandDeps): Array<() => void> {
  const commands = ctx.get('commands')
  if (commands === undefined) return []

  const disposers: Array<() => void> = []

  // /memory-pg-save：提炼 → 分割 → 入库（不生成文件）
  disposers.push(commands.register({
    name: 'memory-pg-save',
    description: '提炼当前会话上下文 → 语义分割 → 存入记忆库',
    input: { hint: '例如：保存这个bug的排查方案' },
    handler: async (invocation) => {
      try {
        const meta = await deps.sessionMeta(invocation.agent)
        const src = await deps.contextProvider(invocation.agent)
        const facts = await distill({ context: src.context, replayPrefix: src.replayPrefix }, deps.distillCaller)
        const res = await persistFacts(deps.store, meta.workspaceId, meta.sessionId, facts)
        return { kind: 'success', text: summaryText('save', facts, res) }
      } catch (error) {
        return { kind: 'error', text: `[memory-pg] save failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // /memory-pg-compact-save：免确认：提炼 + 分割 + 入库 全自动
  disposers.push(commands.register({
    name: 'memory-pg-compact-save',
    description: '免确认：提炼当前会话上下文 → 语义分割 → 直接入库（不生成文件、不等待确认）',
    input: { hint: '例如：保存这个bug的排查方案和问题原因' },
    handler: async (invocation) => {
      try {
        const meta = await deps.sessionMeta(invocation.agent)
        const src = await deps.contextProvider(invocation.agent)
        const facts = await distill({ context: src.context, replayPrefix: src.replayPrefix }, deps.distillCaller)
        const res = await persistFacts(deps.store, meta.workspaceId, meta.sessionId, facts)
        return { kind: 'success', text: summaryText('compact-save', facts, res) }
      } catch (error) {
        return { kind: 'error', text: `[memory-pg] compact-save failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // /memory-pg-compact：提炼 → 生成 md 记忆文件（由用户决定是否保存，不入库）
  disposers.push(commands.register({
    name: 'memory-pg-compact',
    description: '提炼当前会话上下文 → 生成一份 md 记忆文件（不自动入库，由你决定是否保存）',
    input: { hint: '例如：整理当前bug的排查方案' },
    handler: async (invocation) => {
      try {
        const meta = await deps.sessionMeta(invocation.agent)
        const src = await deps.contextProvider(invocation.agent)
        const facts = await distill({ context: src.context, replayPrefix: src.replayPrefix }, deps.distillCaller)
        // 生成 md 文件（不入库）
        const { writeFile, mkdir } = await import('node:fs/promises')
        const { join } = await import('node:path')
        await mkdir(deps.memoryDir, { recursive: true })
        const ts = new Date().toISOString().replace(/[:.]/g, '-')
        const file = join(deps.memoryDir, `memory-${meta.sessionId.slice(0, 8)}-${ts}.md`)
        const md = [
          `# 记忆提炼 ${new Date().toISOString()}`,
          `- session: ${meta.sessionId}`,
          `- workspace: ${meta.workspaceId}`,
          '',
          ...facts.map((f, i) => `## ${i + 1}. ${f.content}\n\n${f.tags.length ? `标签：${f.tags.join(', ')}` : ''}\n`),
        ].join('\n')
        await writeFile(file, md, 'utf8')
        return { kind: 'success', text: `[memory-pg] compact: 提炼 ${facts.length} 条，已生成记忆文件：${file}\n（未入库，如需保存请用 /memory-pg-save 或 /memory-pg-compact-save）` }
      } catch (error) {
        return { kind: 'error', text: `[memory-pg] compact failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // /memory-pg-search：只读检索（关键词 + LLM 重排）
  disposers.push(commands.register({
    name: 'memory-pg-search',
    description: '只读检索记忆库（关键词优先 + LLM 重排），不注入上下文',
    input: { hint: '搜索内容，例如：登录 bug 排查' },
    handler: async (invocation) => {
      try {
        const meta = await deps.sessionMeta(invocation.agent)
        const q = invocation.rawInput.trim()
        if (!q) return { kind: 'error', text: '[memory-pg] search: 请输入搜索内容' }
        const hits: SearchHit[] = await deps.store.searchAndRerank(meta.workspaceId, q, { limit: 10 })
        if (hits.length === 0) return { kind: 'success', text: '[memory-pg] search: 无结果' }
        const lines = [`[memory-pg] search "${q}": ${hits.length} 条结果`]
        for (const h of hits) {
          lines.push(`- [${h.match}] ${h.content}${h.tags.length ? ` [${h.tags.join(', ')}]` : ''}`)
        }
        return { kind: 'success', text: lines.join('\n') }
      } catch (error) {
        return { kind: 'error', text: `[memory-pg] search failed: ${error instanceof Error ? error.message : String(error)}` }
      }
    },
  }))

  // /memory-pg-load：占位（M4 实现注入）
  disposers.push(commands.register({
    name: 'memory-pg-load',
    description: '把本项目记忆注入当前上下文（M4 实现）',
    input: { hint: '加载记忆' },
    handler: async () => ({ kind: 'error', text: '[memory-pg] load: 未实现（M4 里程碑）' }),
  }))

  return disposers
}
