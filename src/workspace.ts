/**
 * dsh-memory-pg workspace 解析（M4 跨项目检索）。
 *
 * DSH 有正式 workspace 概念（workspaceRegistry）：workspace 有
 *   - id:    稳定标识（WorkspaceId）
 *   - title: 显示名（用户看到的"项目名称"）
 *   - path:  目录绝对路径
 * 用户说"在 A 项目里 -p B项目名称 开发规范 从 B 里搜"，这里的"B项目名称"应解析到
 * workspace 的 title 或 path 末段。本模块是**纯函数**（输入 registry 视图 + 用户输入 →
 * 输出解析结果），可独立单测（对齐「核心逻辑先验证」教训一）。
 */

/** workspaceRegistry 的最小视图（避免引 DSH 运行时类型，纯数据可测）。 */
export interface WorkspaceView {
  id: string
  title: string
  path: string
}

/** 解析结果。 */
export type WorkspaceResolveResult =
  | { kind: 'ok'; workspace: WorkspaceView }
  | { kind: 'not-found'; candidates: string[] }

/**
 * 从用户提供的"项目名称/路径/Id"解析 workspace。
 * 匹配优先级：
 *   1. id 精确匹配
 *   2. title 精确匹配（大小写不敏感）
 *   3. path 末段（basename）精确匹配
 *   4. title / path 末段模糊包含（唯一命中才收）
 * 空输入返回 null（调用方用当前 workspace）。
 */
export function resolveWorkspace(
  workspaces: readonly WorkspaceView[],
  input: string,
): WorkspaceResolveResult | null {
  const raw = String(input ?? '').trim()
  if (!raw) return null

  // 1) id 精确
  const byId = workspaces.find(w => w.id === raw)
  if (byId) return { kind: 'ok', workspace: byId }

  const lower = raw.toLowerCase()
  const base = raw.replace(/[\\/]+$/g, '').split(/[\\/]/).pop() ?? raw

  // 2) title 精确（大小写不敏感）
  const byTitle = workspaces.find(w => w.title.toLowerCase() === lower)
  if (byTitle) return { kind: 'ok', workspace: byTitle }

  // 3) path 末段精确
  const byBase = workspaces.find(w => baseOf(w.path) === base)
  if (byBase) return { kind: 'ok', workspace: byBase }

  // 4) title / path 末段模糊包含（唯一命中才收）
  const fuzzy = workspaces.filter(w =>
    w.title.toLowerCase().includes(lower) || baseOf(w.path).toLowerCase().includes(lower))
  if (fuzzy.length === 1) return { kind: 'ok', workspace: fuzzy[0]! }

  return {
    kind: 'not-found',
    candidates: workspaces.map(w => `${w.title} (${w.id}${w.path ? ` @ ${w.path}` : ''})`),
  }
}

/** 取路径末段（跨平台分隔符）。 */
export function baseOf(path: string): string {
  return String(path ?? '').replace(/[\\/]+$/g, '').split(/[\\/]/).pop() ?? ''
}

/**
 * 解析命令行的 `-p <目标>` flag：
 * `/memory-pg-search -p B项目 开发规范` → { target: 'B项目', query: '开发规范' }
 * 不带 `-p` → { target: null, query: 全部输入 }（默认搜当前项目）。
 */
export function parseTargetFlag(rawInput: string): { target: string | null; query: string } {
  const text = String(rawInput ?? '').trim()
  const m = text.match(/^(-p|--project)\s+([^\s-][\s\S]*)$/i)
  if (!m) return { target: null, query: text }
  // `-p 名称 查询词...`：目标取第一个 token，剩余为查询词
  const rest = m[2]!.trim()
  const firstSpace = rest.search(/\s/)
  if (firstSpace === -1) {
    return { target: rest, query: '' }
  }
  const target = rest.slice(0, firstSpace).trim()
  const query = rest.slice(firstSpace).trim()
  return { target, query }
}
