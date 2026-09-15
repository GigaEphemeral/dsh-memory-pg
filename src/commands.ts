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
export type WorkspaceLister = () => Promise<readonly WorkspaceView[]>

/** 把一段文本写回会话对话框（session.append assistant/message）。 */
export type AppendAssistant = (agent: { id: string }, text: string) => Promise<void>

/**
 * M5（F-14）可选向量配置：由 index.ts 注入（vectorEnabled 时启用）。
 * embed：单条文本 → 归一化向量（真实走 EmbeddingClient；测试注入 fake）。
 */
export interface VectorRuntime {
  enabled: boolean
  model: string
  embed: (text: string) => Promise<ArrayLike<number>>
}

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
  /**
   * M5（F-14）：可选向量运行时提供者。每次命令执行时调用，读取最新设置
   * （vectorEnabled/embedding URL 保存后立即生效，无需重启）；缺省 = 不启用向量。
   */
  vectorProvider?: () => VectorRuntime | null
}

/** 取当前向量运行时（无提供者/未启用 → null）。 */
function vectorOf(deps: CommandDeps): VectorRuntime | null {
  return deps.vectorProvider?.() ?? null
}

/** 解析 LLM 返回的三要素事实 → 入库。 */
async function persistFacts(
  store: MemoryStore,
  workspaceId: string,
  sessionId: string,
  facts: DistilledFact[],
  vector: VectorRuntime | null | undefined = null,
): Promise<{ added: FactRecord[]; duplicates: number; conflicts: SegmentedFact[]; vectors: number }> {
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
  // M5（F-14）：向量启用时，对新增事实并发写入 embeddings（分组并发 embed + 入库；
  // 单个失败不阻断入库——向量是增强项，失败时命令结果注明）。
  // 并发化原因：embedding 是串行瓶颈（每条 Ollama 请求 1-3 秒），逐条 await 会拉长命令总时长
  // 触发前端命令超时 abort（2026-09-15 实测：后端已入库但前端显示 "This operation was aborted"）。
  // 分组并发：Ollama 默认并发有限，一次打太多条会排队/超时；每批 CONCURRENCY 条并行。
  let vectors = 0
  if (vector?.enabled && added.length > 0) {
    const CONCURRENCY = 4
    for (let i = 0; i < added.length; i += CONCURRENCY) {
      const batch = added.slice(i, i + CONCURRENCY)
      const results = await Promise.all(batch.map(async (rec) => {
        try {
          const v = await vector.embed(rec.content)
          await store.addFactEmbedding({
            factId: rec.factId,
            workspaceId,
            content: rec.content,
            vector: v,
            model: vector.model,
          })
          return true
        } catch (error) {
          console.error(`[memory-pg] vector write failed for fact#${rec.factId}: ${error instanceof Error ? error.message : String(error)}`)
          return false
        }
      }))
      vectors += results.filter(Boolean).length
    }
  }
  return { added, duplicates, conflicts, vectors }
}

/** 组装一条命令结果文本。 */
function summaryText(
  action: string,
  facts: DistilledFact[],
  res: { added: FactRecord[]; duplicates: number; conflicts: SegmentedFact[]; vectors: number },
): string {
  const lines = [
    `[memory-pg] ${action}: 提炼 ${facts.length} 条事实，新增 ${res.added.length} 条，重复跳过 ${res.duplicates} 条${res.vectors > 0 ? `，向量写入 ${res.vectors} 条` : ''}`,
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

/**
 * 统一出口：结果文本 → 命令卡片始终返回完整文本；
 * appendAssistant（写回对话框）仅作附加增强，失败不影响卡片结果。
 * （2026-09-14 修复：此前 append 启用时返回空 text，导致"结果没了 + 参数被吃掉"）
 */
async function finish(
  deps: CommandDeps,
  invocation: { agent: { id: string } },
  text: string,
  error = false,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  if (!error && deps.appendAssistant && text) {
    await deps.appendAssistant(invocation.agent, text).catch(() => {})
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
        const res = await persistFacts(deps.store, meta.workspaceId, meta.sessionId, facts, vectorOf(deps))
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
        const res = await persistFacts(deps.store, meta.workspaceId, meta.sessionId, facts, vectorOf(deps))
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
        // M5（F-14）：向量启用 → 混合检索（关键词 + 向量 RRF 合并）；否则纯关键词 + 重排。
        const vector = vectorOf(deps)
        const hits: SearchHit[] = vector?.enabled
          ? await deps.store.searchHybrid(parsed.workspaceId, q, {
              embedQuery: vector.embed,
              limit: 10,
              model: vector.model,
            })
          : await deps.store.searchAndRerank(parsed.workspaceId, q, { limit: 10 })
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
