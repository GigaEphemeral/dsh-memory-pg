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
import type { LlmCaller } from './distill.ts'
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

export const name = 'dsh-memory-pg'

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
        res.statusCode = 404
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ ok: false, error: 'not found' }))
      },
    })

    // watch：设置提交后触发（M5 向量开关/工具门控在此扩展）。
    scope.watch(() => {})

    // ── M3：五条 /memory-pg-* 命令接线 ────────────────────────────
    // 依赖注入：store（连接来自 prefs）、distill caller（ctx.llm.stream）、
    // context provider（session.deriveMessages）、sessionMeta（header.cwd）。
    const store = new MemoryStore()
    const connectFromPrefs = (p: MemoryPgPrefs): void => {
      const cfg: DbConfig = { host: p.dbHost, port: p.dbPort, user: p.dbUser, password: p.dbPassword, database: p.dbName }
      store.connect(cfg)
      store.migrate().catch((error) => console.error('[memory-pg] migrate failed', error))
    }
    connectFromPrefs(scope.get())

    // distill caller：包一层 ctx.llm.stream（D4 路线 A）。
    // 不照搬官方 compaction 的前缀缓存/截断检测机制（D-M3-2）：我们的提炼是用户手动触发，
    // 时机随机，前缀缓存收益不确定；保持简单 caller。
    const llm = ctx.get('llm')
    const distillCaller: LlmCaller = async (system, user) => {
      if (llm === undefined) throw new Error('ctx.llm not mounted')
      const providers = llm.listProviders()
      const provider = providers[0]?.id
      if (!provider) throw new Error('no llm provider registered')
      let model = provider
      try {
        const models = await llm.listModels(provider)
        if (models.length > 0) model = models[0].id
      } catch {
        // 保持 provider 占位
      }
      const chunks: string[] = []
      const stream = llm.stream({
        provider,
        model,
        messages: [
          { role: 'system', content: [{ type: 'text', text: system }] },
          { role: 'user', content: [{ type: 'text', text: user }] },
        ],
      } as never)
      for await (const chunk of stream as AsyncIterable<{ type: string; text?: string; block?: { type: string; text?: string } }>) {
        if (chunk.type === 'text-delta' && typeof chunk.text === 'string') chunks.push(chunk.text)
        else if (chunk.type === 'block-end' && chunk.block?.type === 'text' && typeof chunk.block.text === 'string') {
          chunks.push(chunk.block.text)
        }
      }
      return chunks.join('')
    }

    // context provider：读 agent 会话的 deriveMessages() 拼文本。
    const contextProvider = async (agent: { id: string }): Promise<string> => {
      const sessions = ctx.get('sessions') as { get: (id: string) => { deriveMessages: () => Array<{ role: string; content: Array<{ type: string; text?: string }> }> } | undefined } | undefined
      const session = sessions?.get(agent.id)
      if (!session) return ''
      const msgs = session.deriveMessages()
      const lines: string[] = []
      for (const m of msgs) {
        const text = m.content.map(b => (b.type === 'text' ? b.text ?? '' : '')).filter(Boolean).join(' ')
        if (text.trim()) lines.push(`${m.role}: ${text}`)
      }
      return lines.slice(-40).join('\n') // 最近 40 条
    }

    // sessionMeta：从 header.cwd 推 workspaceId（取 cwd 最后一段；无则用 sessionId 兜底）。
    const sessionMeta = async (agent: { id: string }): Promise<{ workspaceId: string; sessionId: string }> => {
      const sessions = ctx.get('sessions') as { get: (id: string) => { header: { cwd?: string } } | undefined } | undefined
      const session = sessions?.get(agent.id)
      const cwd = session?.header.cwd
      const workspaceId = cwd ? cwd.replace(/[\\/]+$/g, '').split(/[\\/]/).pop() ?? 'workspace' : 'workspace'
      return { workspaceId, sessionId: agent.id }
    }

    const memoryDir = join(process.cwd(), '.memory-pg-files')
    const deps: CommandDeps = {
      store,
      distillCaller,
      contextProvider,
      sessionMeta,
      memoryDir,
    }
    const disposers = registerMemoryCommands(ctx, deps)
    ctx.effect(() => () => {
      for (const d of disposers) d()
      void store.close()
    }, 'dsh-memory-pg.commands')
  })
}
