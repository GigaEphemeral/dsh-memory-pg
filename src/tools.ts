/**
 * dsh-memory-pg 模型可调用工具（M4）：memory_search。
 *
 * 模式参考 dsh-local-vector-memory/lib/tools.mjs：`loadPeer('@deepseek-ai/dsh-tools','defineTool')`
 * + `ctx.tools.register(defineTool({...}))` + `ctx.effect` 生命周期。
 * `@deepseek-ai/dsh-tools` 是 peer，构建时 external，运行时由 DSH profile 提供。
 *
 * M4 跨 workspace：memory_search 支持 `project` 参数——不传默认搜当前项目，
 * 传了按 workspaceRegistry 解析到目标项目（复用 workspace.ts 纯函数）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import type { MemoryStore, SearchHit } from './store.ts'
import { resolveWorkspace, type WorkspaceView } from './workspace.ts'

/** 工具运行时依赖（store + workspace 解析 + 当前 agent）。 */
export interface MemoryToolsRuntime {
  store: MemoryStore
  /** 目标名 → workspace 视图（null=用当前） */
  resolveTarget: (target: string) => Promise<WorkspaceView | null>
  /** 按 agent/session 解析当前会话的 workspaceId（默认检索作用域） */
  workspaceIdOfAgent: (agent: { id: string } | undefined) => Promise<string>
  /** 可用 workspace 列表（未知项目时给候选） */
  listWorkspaces: () => Promise<readonly WorkspaceView[]>
}

/** 从 DSH 运行时解析 peer 包（参考 dsh-local-vector-memory/lib/peers.mjs）。 */
function requireCandidates(): Array<NodeRequire> {
  const out: Array<NodeRequire> = []
  try { out.push(createRequire(import.meta.url)) } catch { /* ignore */ }
  const home = process.env.HOME ?? homedir()
  const dshHome = process.env.DSH_HOME ?? join(home, '.dsh')
  for (const base of [join(dshHome, 'profiles', 'node_modules'), join(dshHome, 'node_modules')]) {
    const anchor = join(base, '@deepseek-ai', 'placeholder', 'package.json')
    try { out.push(createRequire(anchor)) } catch { /* ignore */ }
  }
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (;;) {
      const anchor = join(dir, 'node_modules', '@deepseek-ai', 'placeholder', 'package.json')
      if (existsSync(anchor)) { out.push(createRequire(anchor)); break }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch { /* ignore */ }
  return out
}

let defineToolPromise: Promise<unknown> | undefined
function loadDefineTool(): Promise<unknown> {
  if (!defineToolPromise) {
    defineToolPromise = (async () => {
      const errors: string[] = []
      for (const req of requireCandidates()) {
        try {
          const resolved = req.resolve('@deepseek-ai/dsh-tools')
          try {
            const mod = req(resolved)
            if (typeof mod === 'function') return mod
            if (mod && 'defineTool' in mod) return (mod as { defineTool: unknown }).defineTool
          } catch {
            const mod = await import(resolved)
            if ('defineTool' in mod) return mod.defineTool
          }
        } catch (error) {
          errors.push(String((error as Error)?.message ?? error))
        }
      }
      throw new Error(`[dsh-memory-pg] cannot resolve peer "@deepseek-ai/dsh-tools": ${errors.join(' | ')}`)
    })().catch((error) => { defineToolPromise = undefined; throw error })
  }
  return defineToolPromise
}

const TEXT_OUTPUT = {
  schema: { type: 'string' },
  render: (_args: unknown, value: unknown) => [{ type: 'text', text: String(value) }],
}

/** 注册 memory_search 工具。返回 disposer（apply 生命周期持有）。 */
export async function registerMemoryTools(ctx: Context, runtime: MemoryToolsRuntime): Promise<() => void> {
  const defineTool = await loadDefineTool() as (opts: Record<string, unknown>) => unknown
  const tools = ctx.get('tools') as { register: (tool: unknown) => () => void } | undefined
  if (tools === undefined) return () => {}

  const doSearch = async (query: string, project: string | undefined, limit: number, agent?: { id: string }): Promise<string> => {
    if (!query) return 'memory_search: query 不能为空。'
    let workspaceId: string
    let scopeNote = ''
    if (project && project.trim()) {
      const target = await runtime.resolveTarget(project)
      if (target === null) {
        const candidates = (await runtime.listWorkspaces()).map(w => `${w.title} (${w.id})`).slice(0, 10).join('、')
        return `memory_search: 未找到项目「${project}」${candidates ? `；已知项目：${candidates}` : ''}`
      }
      workspaceId = target.id
      scopeNote = `（项目 ${target.title}）`
    } else {
      workspaceId = await runtime.workspaceIdOfAgent(agent)
    }
    const hits: SearchHit[] = await runtime.store.searchAndRerank(workspaceId, query, { limit })
    if (hits.length === 0) return `记忆检索：0 条${scopeNote}`
    const lines = hits.map((h, i) => {
      const tags = h.tags.length > 0 ? ` [${h.tags.join(', ')}]` : ''
      return `${i + 1}. [${h.match}] ${h.content}${tags}`
    })
    return `记忆检索：${hits.length} 条${scopeNote}\n${lines.join('\n')}`
  }

  const disposer = tools.register(defineTool({
    name: 'memory_search',
    description: '检索 dsh-memory-pg 长期记忆库（关键词 + 重排）。回答"我之前说过什么/有什么偏好/上次怎么定的/某项目的开发规范"之前先调用。可用 project 参数跨项目检索（不传默认当前项目）。',
    parameters: {
      query: { type: 'string', required: true, description: '检索问题或相关描述，尽量具体。' },
      project: { type: 'string', description: '可选：目标项目名/路径/id（跨项目检索），不传默认检索当前项目。' },
      limit: { type: 'number', description: '最多返回条数，默认 5，最大 20。' },
    },
    output: TEXT_OUTPUT,
    isConcurrencySafe: () => true,
    execute: async (args: { query?: string; project?: string; limit?: number }, exec?: { agent?: { id: string } }) => {
      const query = String(args?.query ?? '').trim()
      const project = args?.project === undefined ? undefined : String(args.project).trim()
      const limit = Math.max(1, Math.min(20, Number(args?.limit) || 5))
      try {
        return await doSearch(query, project, limit, exec?.agent)
      } catch (error) {
        return `memory_search 失败：${error instanceof Error ? error.message : String(error)}`
      }
    },
  }))
  return disposer
}

/** workspaceRegistry 视图 → WorkspaceView（供 runtime 使用）。 */
export function workspaceViewOf(ws: { id: string; path: string; title: string }): WorkspaceView {
  return { id: ws.id, path: ws.path, title: ws.title }
}

/** 用 workspaceRegistry + 纯函数解析目标（供 runtime.resolveTarget 使用）。 */
export async function resolveWorkspaceTarget(
  list: readonly WorkspaceView[],
  target: string,
): Promise<WorkspaceView | null> {
  const resolved = resolveWorkspace(list, target)
  return resolved?.kind === 'ok' ? resolved.workspace : null
}
