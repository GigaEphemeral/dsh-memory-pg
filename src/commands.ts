/**
 * dsh-memory-pg 命令注册（M3 + M4 跨 workspace 检索）。
 *
 * 数据流（§4.4）：ctx.commands handler（不经模型）→ 取会话上下文 → distill → segment
 * → 按命令出口分流（save 入库 / compact 生成 md / compact-save 免确认全流程 / search 只读 / load 占位）。
 *
 * M4 变更（2026-09-14）：
 * - `/memory-pg-search` 支持 `-p <目标项目>` 跨 workspace 检索（rawInput 自解析，见 workspace.ts）。
 * - 命令结果可选写回对话框：`deps.appendAssistant(agent, text)` 用 session.append 把结果
 *   写成一条 assistant 消息（进入 transcript，而非独立命令卡片）——解决用户"在另一层空间"的疑惑。
 *
 * 依赖注入：handler 需要 store / distill caller / context provider / sessionMeta /
 * workspaceResolver / appendAssistant，全部由 index.ts 注入（本模块可单测，传 stub）。
 */
import type { Context } from '@deepseek-ai/cordis'
import '@deepseek-ai/dsh-settings'
import '@deepseek-ai/dsh-commands'
import type { MemoryStore, FactRecord, SearchHit } from './store.ts'
import { distill, type DistilledFact, type LlmCaller } from './distill.ts'
import { segmentFacts, classifyDedup, type SegmentedFact } from './segment.ts'
import { parseTargetFlag, type WorkspaceResolveResult, type WorkspaceView } from './workspace.ts'

/** 取当前会话上下文的提供者（index.ts 实现：读 session 事件流）。 */
export type ContextProvider = (agent: { id: string }) => Promise<string>

/** 会话元数据提供者（index.ts 注入：从 agent/session 解析 workspace）。 */
export type SessionMetaProvider = (agent: { id: string }) => Promise<{ workspaceId: string; sessionId: string }>

/**
 * workspace 解析：把用户输入的"项目名称/path/id"解析到 workspace。
 * index.ts 注入：输入目标名 → 返回解析结果（跨项目检索用）。
 */
export type WorkspaceResolver = (target: string) => Promise<WorkspaceResolveResult>

/** 当前可用的 workspace 列表（供命令展示 / 帮助）。 */
export type WorkspaceLister = () => readonly WorkspaceView[]

/** 把一段文本写回会话对话框（session.append assistant/message）。 */
export type AppendAssistant = (agent: { id: string }, text: string) => Promise<void>

/** 命令依赖集合。 */
export interface CommandDeps {
  store: MemoryStore
  /**
   * 提炼 LLM caller 工厂：传入当前 agent 以取会话最近一次路由的 provider/model
   * （官方 compaction 同款回退链，见 index.ts makeDistillCaller）。
   */
  distillCaller: (agent: { id: string }) => LlmCaller
  contextProvider: ContextProvider
  sessionMeta: SessionMetaProvider
  /** 跨项目检索：目标名 → workspace 解析（M4） */
  workspaceResolver: WorkspaceResolver
  /** workspace 列表（帮助/展示） */
  workspaceLister: WorkspaceLister
  /** 结果写回对话框（M4；可选：不注入则结果仍为命令卡片） */
  appendAssistant: AppendAssistant | null
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

/** 解析 -p 目标 + 查询词，返回 { workspaceId 或错误信息 }。 */
async function resolveSearchTarget(
  deps: CommandDeps,
  meta: { workspaceId: string },
  rawInput: string,
): Promise<{ ok: true; workspaceId: string; query: string } | { ok: false; error: string }> {
  const { target, query } = parseTargetFlag(rawInput)
  if (!target) {
    return { ok: true, workspaceId: meta.workspaceId, query }
  }
  const resolved = await deps.workspaceResolver(target)
  if (resolved.kind === 'ok') {
    return { ok: true, workspaceId: resolved.workspace.id, query }
  }
  const candidates = resolved.candidates.length > 0
    ? `；已知项目：${resolved.candidates.slice(0, 10).join('、')}`
    : ''
  return { ok: false, error: `未找到项目「${target}」${candidates}` }
}

/** 统一出口：结果文本 → （可选）写回对话框 + 返回命令结果。 */
async function finish(
  deps: CommandDeps,
  invocation: { agent: { id: string } },
  text: string,
  error = false,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  if (!error && deps.appendAssistant) {
    await deps.appendAssistant(invocation.agent, text).catch(() => {})
    // 写回对话框后仍返回一个简短确认（命令卡片本身仍需一个结果）
    return { kind: 'success', text: '' }
  }
  return { kind: error ? 'error' : 'success', text }
}

/** 注册命令。返回各注册的 disposer（由 apply 生命周期持有）。 */
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
        const context = await deps.contextProvider(invocation.agent)
        const facts = await distill(context, deps.distillCaller(invocation.agent))
        const res = await persistFacts(deps.store, meta.workspaceId, meta.sessionId, facts)
        return await finish(deps, invocation, summaryText('save', facts, res))
      } catch (error) {
        return await finish(deps, invocation, `[memory-pg] save failed: ${error instanceof Error ? error.message : String(error)}`, true)
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
        const context = await deps.contextProvider(invocation.agent)
        const facts = await distill(context, deps.distillCaller(invocation.agent))
        const res = await persistFacts(deps.store, meta.workspaceId, meta.sessionId, facts)
        return await finish(deps, invocation, summaryText('compact-save', facts, res))
      } catch (error) {
        return await finish(deps, invocation, `[memory-pg] compact-save failed: ${error instanceof Error ? error.message : String(error)}`, true)
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
        const context = await deps.contextProvider(invocation.agent)
        const facts = await distill(context, deps.distillCaller(invocation.agent))
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
        const text = `[memory-pg] compact: 提炼 ${facts.length} 条，已生成记忆文件：${file}\n（未入库，如需保存请用 /memory-pg-save 或 /memory-pg-compact-save）`
        return await finish(deps, invocation, text)
      } catch (error) {
        return await finish(deps, invocation, `[memory-pg] compact failed: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }))

  // /memory-pg-search：只读检索（M4：支持 -p <项目> 跨 workspace）
  disposers.push(commands.register({
    name: 'memory-pg-search',
    description: '检索记忆库（关键词 + LLM 重排），支持 -p <项目名> 跨项目检索；无 -p 默认当前项目',
    input: { hint: '例如：-p 其他项目 开发规范　或　登录 bug 排查' },
    handler: async (invocation) => {
      try {
        const meta = await deps.sessionMeta(invocation.agent)
        const parsed = await resolveSearchTarget(deps, meta, invocation.rawInput)
        if (!parsed.ok) return await finish(deps, invocation, `[memory-pg] search: ${parsed.error}`, true)
        const q = parsed.query.trim()
        if (!q) return await finish(deps, invocation, '[memory-pg] search: 请输入搜索内容', true)
        const hits: SearchHit[] = await deps.store.searchAndRerank(parsed.workspaceId, q, { limit: 10 })
        if (hits.length === 0) {
          return await finish(deps, invocation, `[memory-pg] search "${q}": 无结果`)
        }
        const lines = [`[memory-pg] search "${q}": ${hits.length} 条结果`]
        for (const h of hits) {
          lines.push(`- [${h.match}] ${h.content}${h.tags.length ? ` [${h.tags.join(', ')}]` : ''}`)
        }
        return await finish(deps, invocation, lines.join('\n'))
      } catch (error) {
        return await finish(deps, invocation, `[memory-pg] search failed: ${error instanceof Error ? error.message : String(error)}`, true)
      }
    },
  }))

  // /memory-pg-load：占位（M4 注入已迁 Future，2026-09-14 用户指示）
  disposers.push(commands.register({
    name: 'memory-pg-load',
    description: '把记忆注入当前上下文（已规划，暂未实现）',
    input: { hint: '加载记忆' },
    handler: async () => ({ kind: 'error', text: '[memory-pg] load: 未实现（已迁 Future）' }),
  }))

  return disposers
}
