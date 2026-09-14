import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { MemoryStore, contentHashOf, keywordScore, type DbConfig } from '../src/store.ts'

/**
 * 单测 PG：用 my_pgvector 容器（5433，无 AGE preload——54320 的 dsh_memory 容器
 * `shared_preload_libraries=age` 会让 TRUNCATE 报 ag_catalog 不存在，见开发经验 M2）。
 * 端口可用 DSH_TEST_PG_PORT 覆盖。
 */
const DB: DbConfig = {
  host: process.env.DSH_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_TEST_PG_PORT ?? 5433),
  user: 'postgres',
  password: process.env.DSH_TEST_PG_PASSWORD ?? 'czq',
  database: 'dsh_memory_pg_test',
}

const store = new MemoryStore()

beforeAll(async () => {
  store.connect(DB)
  await store.migrate()
})

afterAll(async () => {
  await store.close()
})

beforeEach(async () => {
  // 清空数据表，保证用例隔离（保留表结构）。
  await store.truncateAll()
})

describe('contentHashOf / keywordScore', () => {
  it('normalizes content hash (case/whitespace/punct)', () => {
    expect(contentHashOf('用户 偏好简洁回复。')).toBe(contentHashOf('用户偏好简洁回复'))
    expect(contentHashOf('A-B')).toBe(contentHashOf('ab'))
  })

  it('keywordScore hits CJK bigram for long runs', () => {
    // 查询整串 ≤4 直接整串；命中返回 1
    expect(keywordScore('用户偏好简洁回复', '用户偏好')).toBeGreaterThan(0)
    // 不相关 → 0
    expect(keywordScore('编程 java 环境', '登录 bug')).toBe(0)
  })
})

describe('MemoryStore facts CRUD', () => {
  it('addFact inserts and returns the row', async () => {
    const fact = await store.addFact({
      workspaceId: 'ws-test',
      subject: '用户',
      predicate: '偏好',
      object: '简洁回复',
      tags: ['编程'],
      importance: 8,
    })
    expect(fact).not.toBeNull()
    expect(fact!.content).toBe('用户 偏好 简洁回复')
    expect(fact!.tags).toEqual(['编程'])
    expect(fact!.importance).toBe(8)
  })

  it('addFact dedupes by content_hash (returns existing)', async () => {
    const first = await store.addFact({ workspaceId: 'ws-test', subject: 'A', predicate: '是', object: 'B' })
    const second = await store.addFact({ workspaceId: 'ws-test', subject: 'A', predicate: '是', object: 'B' })
    expect(second!.factId).toBe(first!.factId)
  })

  it('softDeleteFact then restoreFact', async () => {
    const fact = await store.addFact({ workspaceId: 'ws-test', subject: 'X', predicate: '依赖', object: 'Y' })
    expect(await store.softDeleteFact(fact!.factId)).toBe(true)
    expect(await store.getFactById(fact!.factId)).toBeNull() // 软删后按 id 不可见
    expect(await store.restoreFact(fact!.factId)).toBe(true)
    expect((await store.getFactById(fact!.factId))!.status).toBe('active')
  })

  it('supersedeFact marks status=superseded + superseded_by', async () => {
    const old = await store.addFact({ workspaceId: 'ws-test', subject: '旧', predicate: '被', object: '取代' })
    const next = await store.addFact({ workspaceId: 'ws-test', subject: '新', predicate: '取代', object: '旧' })
    const changed = await store.supersedeFact([old!.factId], next!.factId)
    expect(changed).toBe(1)
    const oldAfter = await store.getFactById(old!.factId)
    expect(oldAfter!.status).toBe('superseded')
    expect(oldAfter!.supersededBy).toBe(next!.factId)
  })
})

describe('MemoryStore connection lifecycle (问题1)', () => {
  // 独立实例，避免 pause/disconnect 干扰共享 store 的 CRUD 用例。
  let s: MemoryStore
  beforeEach(() => {
    s = new MemoryStore()
  })
  afterEach(async () => {
    // 确保无论用例走到哪种状态都能收尾（close 幂等）。
    await s.close().catch(() => {})
  })

  it('starts disconnected; connect marks connected + target', () => {
    expect(s.status).toBe('disconnected')
    s.connect(DB)
    expect(s.status).toBe('connected')
    const v = s.statusView()
    expect(v.target).toContain(`${DB.host}:${DB.port}`)
    expect(v.reachable).toBeNull()
  })

  it('pause then resume cycles status', () => {
    s.connect(DB)
    return s.pause().then(() => {
      expect(s.status).toBe('paused')
      expect(s.statusView().reachable).toBe(false)
      // paused 状态下 pool 不存在 → 查询抛"已暂停"
      return expect(s.searchFacts('ws-test', 'x')).rejects.toThrow(/暂停/)
    }).then(() => {
      s.resume(DB)
      expect(s.status).toBe('connected')
    })
  })

  it('disconnect clears to disconnected; poolOf throws 未连接', async () => {
    s.connect(DB)
    await s.disconnect()
    expect(s.status).toBe('disconnected')
    await expect(s.searchFacts('ws-test', 'x')).rejects.toThrow(/未连接/)
  })

  it('ping reflects reachability against real PG', async () => {
    s.connect(DB)
    expect(await s.ping()).toBe(true)
    const v = s.statusView()
    expect(v.reachable).toBe(true)
    expect(v.lastPingAt).not.toBeNull()
    // 未连接时 ping → false
    await s.disconnect()
    expect(await s.ping()).toBe(false)
  })
})

describe('MemoryStore keyword search', () => {
  it('searchFacts finds by keyword and ranks', async () => {
    await store.addFact({ workspaceId: 'ws-test', subject: '用户', predicate: '偏好', object: '简洁回复' })
    await store.addFact({ workspaceId: 'ws-test', subject: '登录', predicate: '报错', object: '密码错误' })
    const hits = await store.searchFacts('ws-test', '用户偏好')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].content).toContain('用户')
    expect(hits[0].match).toBe('keyword')
  })

  it('searchFacts filters by tag', async () => {
    await store.addFact({ workspaceId: 'ws-tag', subject: '环境', predicate: '是', object: 'win', tags: ['编程'] })
    await store.addFact({ workspaceId: 'ws-tag', subject: '娱乐', predicate: '是', object: '电影', tags: ['娱乐'] })
    const hits = await store.searchFacts('ws-tag', '环境', { tag: '编程' })
    expect(hits.length).toBe(1)
    expect(hits[0].tags).toContain('编程')
  })

  it('searchAndRerank returns reranked order (scorer flips)', async () => {
    await store.addFact({ workspaceId: 'ws-rr', subject: 'A', predicate: '关于', object: '登录问题', tags: ['编程'] })
    await store.addFact({ workspaceId: 'ws-rr', subject: 'B', predicate: '关于', object: '登录问题详情', tags: ['编程'] })
    const hits = await store.searchAndRerank('ws-rr', '登录', {
      scorer: async (_q, h) => (h.content.includes('详情') ? 100 : 1),
    })
    expect(hits[0].content).toContain('详情')
  })
})
