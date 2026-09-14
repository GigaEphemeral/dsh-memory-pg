import { describe, expect, it } from 'vitest'
import { resolveWorkspace, parseTargetFlag, baseOf } from '../src/workspace.ts'
import type { WorkspaceView } from '../src/workspace.ts'

const WS: WorkspaceView[] = [
  { id: 'ws-dsh-memory-pg', title: 'dsh-memory-pg', path: 'D:\\code\\dsh-memory-pg' },
  { id: 'ws-plugintest', title: 'plugintest', path: 'D:\\code\\plugintest' },
  { id: 'ws-rag-demo', title: 'RAG Demo 项目', path: 'D:/code/rag-demo' },
]

describe('resolveWorkspace', () => {
  it('matches by id exact', () => {
    const r = resolveWorkspace(WS, 'ws-rag-demo')
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok') expect(r.workspace.id).toBe('ws-rag-demo')
  })

  it('matches by title exact (case-insensitive)', () => {
    const r = resolveWorkspace(WS, 'plugintest')
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok') expect(r.workspace.id).toBe('ws-plugintest')
  })

  it('matches by title with Chinese + case', () => {
    const r = resolveWorkspace(WS, 'rag demo 项目')
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok') expect(r.workspace.id).toBe('ws-rag-demo')
  })

  it('matches by path basename', () => {
    const r = resolveWorkspace(WS, 'rag-demo')
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok') expect(r.workspace.id).toBe('ws-rag-demo')
  })

  it('fuzzy match unique', () => {
    const r = resolveWorkspace(WS, 'demo')
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok') expect(r.workspace.id).toBe('ws-rag-demo')
  })

  it('ambiguous fuzzy returns not-found with candidates', () => {
    // "test" 命中 plugintest 和 title 含 test 的（无——这里造一个）
    const r = resolveWorkspace([...WS, { id: 'ws-test-x', title: 'test x', path: 'D:\\t\\x' }], 'test')
    expect(r?.kind).toBe('not-found')
    if (r?.kind === 'not-found') expect(r.candidates.length).toBeGreaterThan(1)
  })

  it('unknown returns not-found with candidate list', () => {
    const r = resolveWorkspace(WS, '不存在的项目')
    expect(r?.kind).toBe('not-found')
  })

  it('resolves stored workspace_id (dir basename) as -p target', () => {
    // 数据库里已存记忆的 workspace_id 是目录名（M4 修复后统一），
    // workspaceLister 把它作为候选，-p plugintest2 应能命中。
    const stored: WorkspaceView[] = [
      { id: 'plugintest', title: 'plugintest', path: 'D:\\000CODE\\plugintest' },
      { id: 'plugintest2', title: 'plugintest2', path: 'D:\\000CODE\\plugintest2' },
    ]
    const r = resolveWorkspace(stored, 'plugintest2')
    expect(r?.kind).toBe('ok')
    if (r?.kind === 'ok') expect(r.workspace.id).toBe('plugintest2')
  })

  it('empty input returns null', () => {
    expect(resolveWorkspace(WS, '  ')).toBeNull()
    expect(resolveWorkspace(WS, '')).toBeNull()
  })
})

describe('parseTargetFlag', () => {
  it('parses -p target + query', () => {
    const r = parseTargetFlag('-p rag-demo 开发规范')
    expect(r.target).toBe('rag-demo')
    expect(r.query).toBe('开发规范')
  })

  it('parses --project long flag', () => {
    const r = parseTargetFlag('--project plugintest 登录 bug')
    expect(r.target).toBe('plugintest')
    expect(r.query).toBe('登录 bug')
  })

  it('parses -p with multi-token target only (no query)', () => {
    const r = parseTargetFlag('-p 我的项目')
    expect(r.target).toBe('我的项目')
    expect(r.query).toBe('')
  })

  it('no flag returns null target + full query', () => {
    const r = parseTargetFlag('开发规范 和 约定')
    expect(r.target).toBeNull()
    expect(r.query).toBe('开发规范 和 约定')
  })

  it('empty returns null target + empty query', () => {
    const r = parseTargetFlag('')
    expect(r.target).toBeNull()
    expect(r.query).toBe('')
  })
})

describe('baseOf', () => {
  it('handles backslash and forward slash', () => {
    expect(baseOf('D:\\code\\dsh-memory-pg')).toBe('dsh-memory-pg')
    expect(baseOf('D:/code/rag-demo')).toBe('rag-demo')
    expect(baseOf('D:/code/rag-demo/')).toBe('rag-demo')
  })
})
