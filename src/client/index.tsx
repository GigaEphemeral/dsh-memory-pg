/**
 * dsh-memory-pg Client half：设置面板「dsh_memory_pg」分区（settings.section）。
 *
 * 契约（0.1.5-rc.1 inspect 核实）：
 * - settings.section 是 list 槽：注册 { name, id, order, label }，一个列表项 = 一个设置页
 * - 左侧列表显示 label（用户要求：左下角设置 → 左侧列表出现 dsh_memory_pg）
 * - 读写经插件 fenced 路由（/memory-pg/api/settings.*），因为 settings RPC 只服务白名单 ns
 * - React.createElement（无 JSX 转换）；浏览器原生 fetch（同源）
 */
import React from 'react'
import { SETTINGS_NS, MEMORY_PG_PREFS_DEFAULTS, parsePrefs, type MemoryPgPrefs } from '../prefs.ts'

const ROUTE = '/memory-pg/api'

async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(`${ROUTE}${path}`, { method: 'GET' })
  return (await res.json()) as T
}

async function apiPost<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${ROUTE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as T
}

/** 设置面板主体：表单 + 连接测试。 */
function MemoryPgSettingsPanel(props: { prefs: MemoryPgPrefs }): React.ReactElement {
  const [form, setForm] = React.useState<MemoryPgPrefs>({ ...props.prefs })
  const [testing, setTesting] = React.useState(false)
  const [steps, setSteps] = React.useState<Array<{ name: string; ok: boolean; detail?: string }>>([])

  const set = (key: keyof MemoryPgPrefs, value: unknown): void => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const save = async (): Promise<void> => {
    try {
      await apiPost<{ ok: boolean; value?: { value?: unknown } }>('/settings.update', {
        patch: { ...form },
      })
    } catch (error) {
      console.error('memory-pg settings save failed', error)
    }
  }

  const runTest = async (): Promise<void> => {
    setTesting(true)
    try {
      const r = await apiPost<{ ok: boolean; steps: Array<{ name: string; ok: boolean; detail?: string }> }>(
        '/connection.test',
        { prefs: { ...form } },
      )
      setSteps(r.steps)
    } catch (error) {
      setSteps([{ name: 'test', ok: false, detail: String(error) }])
    } finally {
      setTesting(false)
    }
  }

  const field = (label: string, key: keyof MemoryPgPrefs, type = 'text'): React.ReactElement =>
    React.createElement('label', { style: { display: 'block', marginBottom: 8 } },
      React.createElement('span', null, label),
      React.createElement('input', {
        type,
        value: String(form[key] ?? ''),
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => {
          const raw = e.target.value
          set(key, type === 'number' ? (raw === '' ? 0 : Number(raw)) : raw)
        },
        style: { marginLeft: 8, padding: '4px 8px' },
      }),
    )

  return React.createElement('div', null,
    React.createElement('h3', null, 'dsh_memory_pg 配置'),
    field('数据库 Host', 'dbHost'),
    field('数据库 Port', 'dbPort', 'number'),
    field('数据库 User', 'dbUser'),
    field('数据库 Password', 'dbPassword', 'password'),
    field('数据库 Name', 'dbName'),
    React.createElement('hr', null),
    field('Embedding Base URL', 'embeddingBaseUrl'),
    field('Embedding Model', 'embeddingModel'),
    field('向量维度', 'vectorDim', 'number'),
    React.createElement('label', { style: { display: 'block', marginBottom: 8 } },
      React.createElement('input', {
        type: 'checkbox',
        checked: form.vectorEnabled,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => set('vectorEnabled', e.target.checked),
      }),
      React.createElement('span', { style: { marginLeft: 4 } }, '启用向量检索（默认关）'),
    ),
    React.createElement('div', { style: { marginTop: 12, display: 'flex', gap: 8 } },
      React.createElement('button', { onClick: runTest, disabled: testing },
        testing ? '测试中…' : '连接测试'),
      React.createElement('button', { onClick: save }, '保存'),
    ),
    steps.length > 0
      ? React.createElement('ul', null,
          steps.map(s =>
            React.createElement('li', { key: s.name },
              `${s.ok ? '✅' : '❌'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`),
          ),
        )
      : null,
  )
}

/** settings.section 分区组件（列表槽，id = SETTINGS_NS）。 */
function SettingsSection(props: { prefs?: unknown }): React.ReactElement {
  const prefs = parsePrefs(props.prefs ?? MEMORY_PG_PREFS_DEFAULTS)
  return React.createElement(MemoryPgSettingsPanel, { prefs })
}

export function apply(ctx: { get(name: string): unknown; slots?: unknown }): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return
  ;(slots as {
    inject: (name: string, cb: () => void) => void
  }).inject('settings.section', () => {
    ;(slots as {
      register: (options: { name: string; id: string; order: number; label: () => string }, component: unknown) => void
    }).register(
      {
        name: 'settings.section',
        id: SETTINGS_NS,
        order: 100,
        label: () => 'dsh_memory_pg',
      },
      SettingsSection,
    )
  })
}
