/**
 * dsh-memory-pg Client half：设置面板「向量记忆」分区（settings.section）。
 *
 * 契约（0.1.5-rc.1 inspect 核实）：
 * - settings.section 是 list 槽：注册 { name, id, order, label }，一个列表项 = 一个设置页
 * - 左侧列表显示 label（用户要求：左下角设置 → 左侧列表出现「向量记忆」）
 * - **owner 渲染时只传 { close } + hooks，不传 prefs**（SettingsRoot.tsx 实测），
 *   因此组件必须自己经 fenced 路由 `/memory-pg/api/settings.get` 读真实值初始化表单，
 *   保存后主动刷新——否则切换设置页再回来会用默认值重置（问题1修复）。
 * - React.createElement（无 JSX 转换）；浏览器原生 fetch（同源）
 *
 * 问题1（勾选丢失）：组件自读 settings 初始化 + 保存后刷新，不依赖 props.prefs。
 * 问题2（连接测试位置）：「测试数据库连接」移到数据库字段正下方，避免误以为是向量连接测试。
 * 问题3（改名）：label「向量记忆」+ 面板标题「向量记忆配置」。
 * 问题4（连接状态卡）：重新探测 / 暂停 / 恢复 / 删除连接（/memory-pg/api/connection.*）。
 */
import React from 'react'
import { SETTINGS_NS, MEMORY_PG_PREFS_DEFAULTS, parsePrefs, type MemoryPgPrefs } from '../prefs.ts'
import { TOKEN, inputStyle, buttonStyle, cardStyle, rowStyle, labelStyle } from './theme.ts'

const ROUTE = '/memory-pg/api'

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

/** 状态徽标文案（中文；颜色走主题令牌）。 */
function statusLabel(view: ConnectionView): { text: string; color: string } {
  if (view.status === 'paused') return { text: '⏸ 已暂停', color: TOKEN.warn }
  if (view.status === 'disconnected') return { text: '⚪ 未连接', color: TOKEN.labelSecondary }
  if (view.reachable === true) return { text: '🟢 已连接（可达）', color: TOKEN.success }
  if (view.reachable === false) return { text: '🔴 已连接（不可达/已断开）', color: TOKEN.error }
  return { text: '🟡 已连接（未探测）', color: TOKEN.warn }
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
        ? React.createElement('span', { style: { color: TOKEN.labelSecondary } }, '检测中…')
        : React.createElement('span', { style: { color: label.color, fontWeight: 600 } }, label.text),
    ),
    view !== null && view.target !== null
      ? React.createElement('div', { style: { marginTop: 6, color: TOKEN.labelSecondary, fontSize: 12 } },
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
    React.createElement('div', { style: { marginTop: 6, color: TOKEN.labelSecondary, fontSize: 12 } },
      '「测试数据库连接」是只读分项检测；「暂停/恢复/删除」管理实际连接池。'),
  )
}

/** 设置面板主体：数据库配置（含连接测试）→ 向量配置 → 连接状态卡。 */
function MemoryPgSettingsPanel(): React.ReactElement {
  // 问题1修复：不再依赖 props.prefs（owner 不传），挂载时自读 settings 初始化表单。
  const [form, setForm] = React.useState<MemoryPgPrefs>({ ...MEMORY_PG_PREFS_DEFAULTS })
  const [loaded, setLoaded] = React.useState(false)
  const [testing, setTesting] = React.useState(false)
  const [steps, setSteps] = React.useState<Array<{ name: string; ok: boolean; detail?: string }>>([])
  const [saveStatus, setSaveStatus] = React.useState('')

  const load = async (): Promise<void> => {
    try {
      const r = await apiGet<{ ok: boolean; value: { value?: unknown } }>('/settings.get')
      if (r.ok && r.value.value !== undefined) {
        setForm(parsePrefs(r.value.value))
      }
    } catch {
      /* 路由未就绪时用默认值 */
    } finally {
      setLoaded(true)
    }
  }
  React.useEffect(() => {
    void load()
  }, [])

  const set = (key: keyof MemoryPgPrefs, value: unknown): void => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  const save = async (): Promise<void> => {
    try {
      const r = await apiPost<{ ok: boolean; value?: { value?: unknown } }>('/settings.update', {
        patch: { ...form },
      })
      if (r.ok) {
        setSaveStatus('已保存 ✓')
        // 保存成功后重新读（revision 已变），表单与库中一致
        if (r.value?.value !== undefined) setForm(parsePrefs(r.value.value))
      } else {
        setSaveStatus('保存失败：' + String((r as { error?: string }).error ?? '未知错误'))
      }
    } catch (error) {
      setSaveStatus('保存失败：' + String(error))
    }
    setTimeout(() => setSaveStatus(''), 3000)
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
    React.createElement('label', { style: labelStyle },
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

  if (!loaded) {
    return React.createElement('div', null,
      React.createElement('h3', null, '向量记忆配置'),
      React.createElement('div', { style: { color: TOKEN.labelSecondary } }, '读取配置中…'))
  }

  return React.createElement('div', null,
    React.createElement('h3', null, '向量记忆配置'),
    // ── 数据库配置 + 连接测试（问题2：测试按钮紧跟数据库字段，标注清楚） ──
    field('数据库 Host', 'dbHost'),
    field('数据库 Port', 'dbPort', 'number'),
    field('数据库 User', 'dbUser'),
    field('数据库 Password', 'dbPassword', 'password'),
    field('数据库 Name', 'dbName'),
    React.createElement('div', { style: rowStyle },
      React.createElement('button', { style: buttonStyle, onClick: runTest, disabled: testing },
        testing ? '测试中…' : '测试数据库连接'),
    ),
    steps.length > 0
      ? React.createElement('ul', null,
          steps.map(s =>
            React.createElement('li', { key: s.name },
              `${s.ok ? '✅' : '❌'} ${s.name}${s.detail ? ` — ${s.detail}` : ''}`),
          ),
        )
      : null,
    React.createElement('hr', null),
    // ── 向量配置 ──
    field('Embedding 端点 URL', 'embeddingBaseUrl'),
    React.createElement('div', { style: { marginLeft: 8, marginTop: -4, color: TOKEN.labelSecondary, fontSize: 12 } },
      '完整端点 URL（客户端不补路径），如 http://localhost:11434/v1/embeddings（Ollama）'),
    field('Embedding Model', 'embeddingModel'),
    field('向量维度', 'vectorDim', 'number'),
    React.createElement('label', { style: labelStyle },
      React.createElement('input', {
        type: 'checkbox',
        checked: form.vectorEnabled,
        onChange: (e: React.ChangeEvent<HTMLInputElement>) => set('vectorEnabled', e.target.checked),
      }),
      React.createElement('span', { style: { marginLeft: 4 } }, '启用向量检索（默认关）'),
    ),
    React.createElement('div', { style: rowStyle },
      React.createElement('button', { style: buttonStyle, onClick: save }, '保存'),
      saveStatus !== '' ? React.createElement('span', { style: { color: TOKEN.success, fontSize: 12 } }, saveStatus) : null,
    ),
    React.createElement(ConnectionCard),
  )
}

/** settings.section 分区组件（列表槽，id = SETTINGS_NS）。 */
function SettingsSection(): React.ReactElement {
  // 不再接收 prefs prop（owner 不传）；面板内部自读 settings。
  return React.createElement(MemoryPgSettingsPanel)
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
        label: () => '向量记忆',
      },
      SettingsSection,
    )
  })
}
