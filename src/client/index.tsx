/**
 * dsh-memory-pg Client half：设置面板「dsh_memory_pg」分区（settings.section）。
 *
 * 契约（0.1.5-rc.1 inspect 核实）：
 * - settings.section 是 list 槽：注册 { name, id, order, label }，一个列表项 = 一个设置页
 * - 左侧列表显示 label（用户要求：左下角设置 → 左侧列表出现 dsh_memory_pg）
 * - 读写经插件 fenced 路由（/memory-pg/api/settings.*），因为 settings RPC 只服务白名单 ns
 * - React.createElement（无 JSX 转换）；浏览器原生 fetch（同源）
 *
 * 问题1（连接状态）：连接状态卡片 —— 查看已连接 PG 的状态（是否断开）、
 *   暂停 / 恢复 / 删除连接（store 状态机 connected/paused/disconnected，路由 connection.*）。
 * 问题3（圆角统一）：面板统一 8px 圆角（功能优先，仅样式层）。
 */
import React from 'react'
import { SETTINGS_NS, MEMORY_PG_PREFS_DEFAULTS, parsePrefs, type MemoryPgPrefs } from '../prefs.ts'

const ROUTE = '/memory-pg/api'

/** 统一圆角（问题3）。 */
const ROUND = 8
/** 统一控件/卡片样式（内联，轻量）。 */
const inputStyle: React.CSSProperties = {
  marginLeft: 8,
  padding: '4px 10px',
  borderRadius: ROUND,
  border: '1px solid #d0d7de',
  fontSize: 13,
}
const buttonStyle: React.CSSProperties = {
  padding: '5px 14px',
  borderRadius: ROUND,
  border: '1px solid #d0d7de',
  background: '#f6f8fa',
  cursor: 'pointer',
  fontSize: 13,
}
const cardStyle: React.CSSProperties = {
  border: '1px solid #d0d7de',
  borderRadius: ROUND,
  padding: '10px 12px',
  marginTop: 12,
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  marginTop: 8,
  flexWrap: 'wrap',
}

/** 连接状态视图（host 侧 /connection.status 返回）。 */
interface ConnectionView {
  status: 'connected' | 'paused' | 'disconnected'
  reachable: boolean | null
  lastPingAt: string | null
  target: string | null
}

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

/** 状态徽标文案（中文）。 */
function statusLabel(view: ConnectionView): { text: string; color: string } {
  if (view.status === 'paused') return { text: '⏸ 已暂停', color: '#9a6700' }
  if (view.status === 'disconnected') return { text: '⚪ 未连接', color: '#57606a' }
  if (view.reachable === true) return { text: '🟢 已连接（可达）', color: '#1a7f37' }
  if (view.reachable === false) return { text: '🔴 已连接（不可达/已断开）', color: '#cf222e' }
  return { text: '🟡 已连接（未探测）', color: '#9a6700' }
}

/** 连接状态卡片：查看 / 暂停 / 恢复 / 删除连接（问题1）。 */
function ConnectionCard(): React.ReactElement {
  const [view, setView] = React.useState<ConnectionView | null>(null)
  const [busy, setBusy] = React.useState(false)

  const refresh = async (): Promise<void> => {
    try {
      const r = await apiGet<{ ok: boolean; view: ConnectionView }>('/connection.status')
      if (r.ok) setView(r.view)
    } catch {
      /* 面板未就绪时静默 */
    }
  }
  React.useEffect(() => {
    void refresh()
  }, [])

  const act = async (action: 'ping' | 'pause' | 'resume' | 'delete'): Promise<void> => {
    setBusy(true)
    try {
      const r = await apiPost<{ ok: boolean; view: ConnectionView }>(`/connection.${action}`, {})
      if (r.ok) setView(r.view)
    } catch {
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  const label = view === null ? null : statusLabel(view)
  const isPaused = view?.status === 'paused'
  const isConnected = view?.status === 'connected'
  const isDisconnected = view?.status === 'disconnected'

  return React.createElement('div', { style: cardStyle },
    React.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between' } },
      React.createElement('strong', null, '数据库连接'),
      label === null
        ? React.createElement('span', { style: { color: '#57606a' } }, '检测中…')
        : React.createElement('span', { style: { color: label.color, fontWeight: 600 } }, label.text),
    ),
    view !== null && view.target !== null
      ? React.createElement('div', { style: { marginTop: 6, color: '#57606a', fontSize: 12 } },
          `目标：${view.target}`,
          view.lastPingAt !== null ? `　｜　上次探测：${new Date(view.lastPingAt).toLocaleString()}` : '',
        )
      : null,
    React.createElement('div', { style: rowStyle },
      React.createElement('button', { style: buttonStyle, onClick: () => void act('ping'), disabled: busy || isDisconnected },
        isDisconnected ? '探测（需先连接）' : '重新探测'),
      React.createElement('button', {
        style: buttonStyle,
        onClick: () => void act('pause'),
        disabled: busy || !isConnected,
        title: isConnected ? '断开连接池并暂停使用' : '仅已连接时可暂停',
      }, '暂停'),
      React.createElement('button', {
        style: buttonStyle,
        onClick: () => void act('resume'),
        disabled: busy || !(isPaused || isDisconnected),
        title: isPaused ? '用当前配置重新连接' : '仅已暂停/未连接时可恢复',
      }, '恢复'),
      React.createElement('button', {
        style: buttonStyle,
        onClick: () => void act('delete'),
        disabled: busy || isDisconnected,
        title: isDisconnected ? '已无连接可删除' : '断开并删除当前连接（配置保留）',
      }, '删除连接'),
    ),
    React.createElement('div', { style: { marginTop: 6, color: '#57606a', fontSize: 12 } },
      '「连接测试」是只读分项检测；「暂停/恢复/删除」管理实际连接池。'),
  )
}

/** 设置面板主体：表单 + 连接测试 + 连接状态卡。 */
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
        style: inputStyle,
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
    React.createElement('div', { style: rowStyle },
      React.createElement('button', { style: buttonStyle, onClick: runTest, disabled: testing },
        testing ? '测试中…' : '连接测试'),
      React.createElement('button', { style: buttonStyle, onClick: save }, '保存'),
    ),
    steps.length > 0
      ? React.createElement('ul', null,
          steps.map(s =>
            React.createElement('li', { key: s.name },
              `${s.ok ? '✅' : '❌'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`),
          ),
        )
      : null,
    React.createElement(ConnectionCard),
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
