/**
 * dsh-memory-pg Node half 入口（完整 Cordis 插件）。
 *
 * M1 范围：挂载成功 + 设置命名空间注册 + fenced 设置路由 + 连接测试。
 * M3+ 范围：/memory-pg-* 命令、提炼、入库（后续里程碑追加）。
 *
 * 契约（0.1.5-rc.1 inspect 核实）：
 * - settings: ctx.get('settings') → register(ns, schema, {base?,applies?}) /
 *   describe({redactSecrets:true}) / update(ns, patch, rev)
 * - webServer: ctx.get('webServer') → register({kind:'prefix', path, handler})
 * - 命名空间须为 lowercase-hyphenated（'dsh-memory-pg' 合法）
 */
import type { Context } from '@deepseek-ai/cordis'
// 加载 dsh-settings 的 Context 增强（ctx.settings 类型 + SettingsScope）。
import '@deepseek-ai/dsh-settings'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { SETTINGS_NS, type MemoryPgPrefs } from './prefs.ts'
import { PrefsSchema } from './config.ts'
import { MemoryStore, type DbConfig } from './store.ts'
import { registerMemoryCommands, type CommandDeps } from './commands.ts'
import { registerMemoryTools } from './tools.ts'
import type { LlmCaller } from './distill.ts'
import { resolveWorkspace, baseOf, type WorkspaceView } from './workspace.ts'
import { join } from 'node:path'

/** 连接测试分项步骤结果。 */
export interface TestStep {
  name: string
  ok: boolean
  detail?: string
}

/** fenced 路由的 settings 视图（含 revision 供 CAS）。 */
interface SettingsView {
  value?: MemoryPgPrefs
  revision?: number
  externalDisable?: boolean
}

export const name = '@GigaEphemeral/dsh-memory-pg'

export function apply(ctx: Context): void {
  // ── 设置命名空间注册（可选服务：settings 缺失时插件照常工作） ─────
  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(SETTINGS_NS, PrefsSchema, {
      applies: 'live',
    }) as unknown as {
      get(): MemoryPgPrefs
      watch(cb: (next: MemoryPgPrefs) => void): () => void
    }

    const viewOf = (): SettingsView => {
      const d = sctx.settings.describe({ redactSecrets: true })
        .find(candidate => candidate.ns === SETTINGS_NS)
      return d === undefined
        ? { value: undefined, revision: undefined }
        : { value: d.value as MemoryPgPrefs | undefined, revision: d.revision }
    }

    // 连接测试：分项报告（TCP/扩展/表结构/维度），AGE 项不测试（D3 否决）。
    const testConnection = async (prefs: MemoryPgPrefs): Promise<TestStep[]> => {
      const steps: TestStep[] = []
      // 懒加载 pg，避免插件挂载时就必须有 pg（保持轻启动）。
      const { Client } = await import('pg')
      const client = new Client({
        host: prefs.dbHost,
        port: prefs.dbPort,
        user: prefs.dbUser,
        password: prefs.dbPassword,
        database: prefs.dbName,
        connectionTimeoutMillis: 5000,
      })
      try {
        await client.connect()
        steps.push({ name: 'connect', ok: true, detail: `${prefs.dbHost}:${prefs.dbPort}/${prefs.dbName}` })
      } catch (error) {
        steps.push({
          name: 'connect',
          ok: false,
          detail: error instanceof Error ? error.message : String(error),
        })
        return steps
      }
      try {
        const r = await client.query(
          `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
        )
        steps.push({
          name: 'pgvector',
          ok: r.rowCount !== null && r.rowCount > 0,
          detail: r.rows[0]?.extversion ?? 'vector 扩展未安装',
        })
      } catch (error) {
        steps.push({ name: 'pgvector', ok: false, detail: String(error) })
      }
      try {
        const r = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'facts' LIMIT 1`,
        )
        steps.push({
          name: 'schema',
          ok: r.rowCount !== null && r.rowCount > 0,
          detail: r.rowCount ? 'facts 表存在' : 'facts 表不存在（未迁移）',
        })
      } catch (error) {
        steps.push({ name: 'schema', ok: false, detail: String(error) })
      }
      // 维度：仅当启用向量时比对（bge-m3 = prefs.vectorDim）
      try {
        const r = await client.query(
          `SELECT atttypmod FROM pg_attribute WHERE attrelid = 'facts'::regclass AND attname = 'embedding'`,
        )
        if (r.rowCount && r.rowCount > 0) {
          const dim = (r.rows[0]?.atttypmod as number | null ?? -1) - 4
          steps.push({
            name: 'dim',
            ok: dim === prefs.vectorDim,
            detail: `库中 embedding 维度=${dim}，配置维度=${prefs.vectorDim}`,
          })
        } else {
          steps.push({ name: 'dim', ok: true, detail: 'facts.embedding 列不存在（跳过）' })
        }
      } catch (error) {
        steps.push({ name: 'dim', ok: false, detail: String(error) })
      }
      await client.end().catch(() => {})
      return steps
    }

    // ── store：连接池（连接来自 prefs；路由/命令共用） ─────────────
    const store = new MemoryStore()
    const dbConfigOf = (p: MemoryPgPrefs): DbConfig => ({
      host: p.dbHost,
      port: p.dbPort,
      user: p.dbUser,
      password: p.dbPassword,
      database: p.dbName,
    })
    const connectFromPrefs = (p: MemoryPgPrefs): void => {
      store.connect(dbConfigOf(p))
      store.migrate().catch((error) => console.error('[memory-pg] migrate failed', error))
    }
    connectFromPrefs(scope.get())

    // settings.get / settings.update：客户端经此 fenced 路由读写（settings RPC
    // 只服务白名单 ns，见 README §14.2）。
    ctx.get('webServer')?.register({
      kind: 'prefix',
      path: '/memory-pg/api',
      handler: async (req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? '', 'http://localhost')
        if (url.pathname.endsWith('/settings.get') && req.method === 'GET') {
          const view = viewOf()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, value: view }))
          return
        }
        if (url.pathname.endsWith('/settings.update') && req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += String(chunk)
          try {
            const payload = JSON.parse(body) as { patch?: Record<string, unknown>; expectedRevision?: number }
            await sctx.settings.update(SETTINGS_NS, payload.patch ?? {}, payload.expectedRevision)
            const view = viewOf()
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: true, value: view }))
          } catch (error) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(error) }))
          }
          return
        }
        if (url.pathname.endsWith('/connection.test') && req.method === 'POST') {
          let body = ''
          for await (const chunk of req) body += String(chunk)
          try {
            const payload = JSON.parse(body) as { prefs?: Partial<MemoryPgPrefs> }
            const prefs = { ...scope.get(), ...(payload.prefs ?? {}) } as MemoryPgPrefs
            const steps = await testConnection(prefs)
            const ok = steps.every(s => s.ok)
            res.statusCode = 200
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok, steps }))
          } catch (error) {
            res.statusCode = 400
            res.setHeader('content-type', 'application/json')
            res.end(JSON.stringify({ ok: false, error: String(error) }))
          }
          return
        }
        // ── 连接状态：查看/暂停/恢复/删除（问题1） ────────────────
        if (url.pathname.endsWith('/connection.status') && req.method === 'GET') {
          const view = store.statusView()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, view }))
          return
        }
        if (url.pathname.endsWith('/connection.ping') && req.method === 'POST') {
          const reachable = await store.ping()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, reachable, view: store.statusView() }))
          return
        }
        if (url.pathname.endsWith('/connection.pause') && req.method === 'POST') {
          await store.pause()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, view: store.statusView() }))
          return
        }
        if (url.pathname.endsWith('/connection.resume') && req.method === 'POST') {
          store.resume(dbConfigOf(scope.get()))
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, view: store.statusView() }))
          return
        }
        if (url.pathname.endsWith('/connection.delete') && req.method === 'POST') {
          await store.disconnect()
          res.statusCode = 200
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify({ ok: true, view: store.statusView() }))
          return
        }
        res.statusCode = 404
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'not found' }))
        return
      },
    })

    // watch：设置提交后触发（M5 向量开关/工具门控在此扩展）。
    scope.watch(() => {})

    // ── M3：五条 /memory-pg-* 命令接线 ────────────────────────────
    // 依赖注入：store（上方已连接）、distill caller（ctx.llm.stream）、
    // context provider（session.deriveMessages）、sessionMeta（header.cwd）。
    // store 已在路由段 connectFromPrefs(scope.get()) 建立并 migrate。

    // distill caller 工厂：包一层 ctx.llm.stream（D4 路线 A）。
    // 不照搬官方 compaction 的前缀缓存/截断检测机制（D-M3-2）：我们的提炼是用户手动触发，
    // 时机随机，前缀缓存收益不确定；保持简单 caller。
    // 但两处**契约级**吸收（问题4修复，2026-09-14 实测）：
    // 1) provider/model 选择：优先取该会话最近一次路由的 requestHeader().config
    //    （官方 summarizer.ts 的 latest 回退链），而不是 listModels()[0]——后者可能命中
    //    无效模型（deepseek-flash 组合曾导致 stream 0 输出）。
    // 2) finish 检查：adapter 失败不抛异常，而是产出 finish chunk（reason: error/aborted/
    //    max-tokens），必须检查并报错（官方 BlockAssembler.finish + finishError）。
    const llm = ctx.get('llm')
    const makeDistillCaller = (agent: { id: string }): LlmCaller => async (system, user) => {
      if (llm === undefined) throw new Error('ctx.llm not mounted')
      // 1) provider/model：requestHeader().config → listProviders()[0]（回退）
      let provider: string | undefined
      let model: string | undefined
      try {
        const sessions = ctx.get('sessions') as { get: (id: string) => { requestHeader: () => { config?: { provider?: string; model?: string } } | undefined } | undefined } | undefined
        const header = sessions?.get(agent.id)?.requestHeader?.()
        if (header?.config?.provider) {
          provider = header.config.provider
          model = header.config.model ?? header.config.provider
        }
      } catch {
        // 回退到 provider 目录
      }
      if (!provider) {
        const providers = llm.listProviders()
        provider = providers[0]?.id
        if (!provider) throw new Error('no llm provider registered')
        model = provider
        try {
          const models = await llm.listModels(provider)
          if (models.length > 0) model = models[0].id
        } catch {
          // 保持 provider 占位
        }
      }
      const chunks: string[] = []
      let finishReason: string | undefined
      let finishDetail = ''
      const stream = llm.stream({
        provider,
        model,
        sessionId: agent.id,
        messages: [
          { role: 'system', content: [{ type: 'text', text: system }] },
          { role: 'user', content: [{ type: 'text', text: user }] },
        ],
      } as never)
      // 2) 遍历 chunk：收集 text-delta/block-end，同时捕获 finish reason
      for await (const chunk of stream as AsyncIterable<{ type: string; text?: string; block?: { type: string; text?: string }; reason?: { kind?: string; failure?: { message?: string } } }>) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text)
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
          chunks.push(chunk.block.text)
        } else if (chunk.type === 'finish' && chunk.reason) {
          finishReason = chunk.reason.kind
          finishDetail = chunk.reason.failure?.message ?? ''
        }
      }
      if (finishReason === 'error' || finishReason === 'aborted') {
        throw new Error(`llm stream ${finishReason}${finishDetail ? `: ${finishDetail}` : ''}`)
      }
      if (finishReason === 'max-tokens') {
        throw new Error('llm stream truncated at max tokens (incomplete distill)')
      }
      const out = chunks.join('')
      console.error(`[memory-pg][diag] distillCaller: provider=${provider} model=${model} finish=${finishReason ?? 'none'} system=${system.length}chars user=${user.length}chars raw=${out.length}chars rawHead=${JSON.stringify(out.slice(0, 120))}`)
      return out
    }

    // context provider：读 agent 会话的 deriveMessages() 拼文本。
    // 问题4诊断：输出关键链路的可观测信息（sessions 服务/session 命中/消息条数/文本长度），
    // 便于在 err.log 定位「提炼 0 条」根因；定位后按需降级为安静实现。
    const contextProvider = async (agent: { id: string }): Promise<string> => {
      const sessions = ctx.get('sessions') as { get: (id: string) => { deriveMessages: () => Array<{ role: string; content: Array<{ type: string; text?: string }> }> } | undefined } | undefined
      if (sessions === undefined) {
        console.error(`[memory-pg][diag] contextProvider: ctx.get('sessions') = undefined`)
        return ''
      }
      const session = sessions.get(agent.id)
      if (session === undefined) {
        console.error(`[memory-pg][diag] contextProvider: sessions.get('${agent.id}') = undefined (agent 非 live session?)`)
        return ''
      }
      const msgs = session.deriveMessages()
      const lines: string[] = []
      for (const m of msgs) {
        // 过滤 system 角色（系统提示词/工具规则/agent 预设）——这些不是会话语义内容，
        // 喂给提炼 LLM 会被当成"约定/偏好"提取（2026-09-14 实测提炼出 8 条工具规则）。
        if (m.role === 'system') continue
        const text = m.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).filter(Boolean).join(' ')
        if (text.trim()) lines.push(`${m.role}: ${text}`)
      }
      const out = lines.slice(-40).join('\n')
      console.error(`[memory-pg][diag] contextProvider: agent=${agent.id} derived=${msgs.length} nonSystem=${lines.length} chars=${out.length}`)
      return out
    }

    // sessionMeta（M4 修正）：workspaceId 统一用 cwd 目录名（basename）。
    // 为什么不用 workspaceRegistry.id：它是 UUID，不可读、依赖 registry 状态、跨实例不一致；
    // 而 cwd 目录名（如 plugintest）是用户理解的"项目名"，且与 M3 已存数据（16 条 plugintest）
    // 一致。此前用 registry id 导致新记忆进 UUID、旧记忆在目录名下互相搜不到（2026-09-14 实测）。
    const sessionMeta = async (agent: { id: string }): Promise<{ workspaceId: string; sessionId: string }> => {
      const sessions = ctx.get('sessions') as { get: (id: string) => { header: { cwd?: string } } | undefined } | undefined
      const session = sessions?.get(agent.id)
      const cwd = session?.header.cwd
      const workspaceId = cwd ? baseOf(cwd) || 'workspace' : 'workspace'
      return { workspaceId, sessionId: agent.id }
    }

    // workspace 候选：registry list + 数据库已有 workspace_id 的并集。
    // id 统一用目录名 basename（与 sessionMeta 一致），title 用 registry 的显示名。
    const workspaceView = (id: string, title: string, path: string): WorkspaceView => ({ id, title, path })

    const workspaceLister = async (): Promise<readonly WorkspaceView[]> => {
      const seen = new Map<string, WorkspaceView>()
      const registry = ctx.get('workspaceRegistry') as { list: () => Array<{ id: string; path: string; title: string }> } | undefined
      if (registry) {
        try {
          for (const ws of registry.list()) {
            const id = baseOf(ws.path) || ws.id
            seen.set(id, workspaceView(id, ws.title || id, ws.path))
          }
        } catch { /* registry 不可用则忽略 */ }
      }
      // 数据库已有 workspace_id 兜底（registry 没覆盖但已有记忆的项目）
      try {
        const rows = await store.listWorkspaceIds()
        for (const id of rows) {
          if (!seen.has(id)) seen.set(id, workspaceView(id, id, ''))
        }
      } catch { /* store 未连则忽略 */ }
      return [...seen.values()]
    }

    // workspace 解析：目标名 → workspace（resolveWorkspace 纯函数 + 候选列表）。
    const workspaceResolver: (target: string) => Promise<import('./workspace.ts').WorkspaceResolveResult> = async (target) => {
      const list = await workspaceLister()
      const resolved = resolveWorkspace(list, target)
      if (resolved === null) {
        return { kind: 'not-found', candidates: list.map(w => `${w.title} (${w.id})`) }
      }
      return resolved
    }

    // 结果写回对话框：用户要求回退（2026-09-14）。命令结果只显示在命令卡片，不写进对话流。
    const appendAssistant: CommandDeps['appendAssistant'] = null

    const memoryDir = join(process.cwd(), '.memory-pg-files')
    const deps: CommandDeps = {
      store,
      distillCaller: makeDistillCaller,
      contextProvider,
      sessionMeta,
      workspaceResolver,
      workspaceLister,
      appendAssistant,
      memoryDir,
    }
    const disposers = registerMemoryCommands(ctx, deps)

    // ── M4：memory_search 模型工具（2026-09-14 用户指示：注释掉，不做） ──
    // 原因：模型自动调用 memory_search 会产生误导（用户可能本意是联网搜索）；记忆检索
    // 必须通过 /memory-pg-search 命令显式执行。工具注册代码保留，需要时取消注释即可。
    // const toolRuntime = {
    //   store,
    //   resolveTarget: async (target: string) => {
    //     const list = workspaceLister()
    //     const resolved = resolveWorkspace(list, target)
    //     return resolved?.kind === 'ok' ? resolved.workspace : null
    //   },
    //   workspaceIdOfAgent: async (agent?: { id: string }) => {
    //     if (!agent) return 'workspace'
    //     return (await sessionMeta(agent)).workspaceId
    //   },
    //   listWorkspaces: workspaceLister,
    // }
    // void registerMemoryTools(ctx, toolRuntime).then((disposer) => {
    //   if (disposer) {
    //     ctx.effect(() => disposer, 'dsh-memory-pg.tools')
    //   }
    // }).catch((error) => {
    //   console.error('[memory-pg] tools registration failed', error)
    // })

    ctx.effect(() => () => {
      for (const d of disposers) d()
      void store.close()
    }, 'dsh-memory-pg.commands')
  })
}
