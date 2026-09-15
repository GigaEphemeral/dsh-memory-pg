import { describe, expect, it, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { MemoryStore, contentHashOf, keywordScore, type DbConfig } from '../src/store.ts'

/**
 * 单测 PG：用 my_pgvector 容器（5433，无 AGE preload——54320 的 dsh_memory 容器
 * `shared_preload_libraries=age` 会让 TRUNCATE 报 ag_catalog 不存在，见开发经验 M2）。
 * 端口可用 DSH_TEST_PG_PORT 覆盖；密码经 DSH_TEST_PG_PASSWORD 环境变量提供
 * （不在代码里硬编码；本地跑测试前 `$env:DSH_TEST_PG_PASSWORD='***'`）。
 */
const DB: DbConfig = {
  host: process.env.DSH_TEST_PG_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_TEST_PG_PORT ?? 5433),
  user: 'postgres',
  password: process.env.DSH_TEST_PG_PASSWORD ?? '',
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

describe('MemoryStore vector (M5 F-14)', () => {
  // 库中 embeddings.embedding 列是 VECTOR(1024)（schema.ts），测试向量必须同维
  // （§2.2⑥ 维度一致性：PG 会对维度不匹配显式报 expected 1024 dimensions）。
  const VEC_DIM = 1024

  /** 确定性语义向量：每个字符一个固定随机方向，文本向量 = 字符方向之和再归一化。
   *  共享字符越多余弦越高（近似"语义相关"），同文本恒同向量。 */
  const charDir = new Map<string, number[]>()
  function vecOf(text: string): number[] {
    const sum = new Array<number>(VEC_DIM).fill(0)
    for (const ch of String(text)) {
      let dir = charDir.get(ch)
      if (dir === undefined) {
        let seed = [...ch].reduce((s, c) => (s * 31 + (c.codePointAt(0) ?? 0)) >>> 0, 7)
        dir = new Array<number>(VEC_DIM)
        for (let i = 0; i < VEC_DIM; i += 1) {
          seed = (seed * 1103515245 + 12345) >>> 0
          dir[i] = (seed % 1000) / 1000 - 0.5
        }
        charDir.set(ch, dir)
      }
      for (let i = 0; i < VEC_DIM; i += 1) sum[i] += dir[i]
    }
    const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0))
    return norm === 0 ? sum : sum.map(x => x / norm)
  }

  it('addFactEmbedding stores + searchFactsVector finds by cosine', async () => {
    await store.addFact({ workspaceId: 'ws-vec', subject: '登录', predicate: '报错', object: '密码错误' })
    await store.addFact({ workspaceId: 'ws-vec', subject: '数据库', predicate: '连接', object: '超时' })
    const list = await store.listFacts('ws-vec')
    const login = list.find(f => f.content.includes('登录'))
    const db = list.find(f => f.content.includes('数据库'))
    expect(login).not.toBeUndefined()
    expect(db).not.toBeUndefined()
    await store.addFactEmbedding({ factId: login!.factId, workspaceId: 'ws-vec', content: login!.content, vector: vecOf('登录 报错 密码'), model: 'fake' })
    await store.addFactEmbedding({ factId: db!.factId, workspaceId: 'ws-vec', content: db!.content, vector: vecOf('数据库 连接 超时'), model: 'fake' })

    // 查询「密码错误」向量 → 登录条应排前（字符方向向量：与登录条共享「密码/登录」字符，
    // 余弦显著高于只共享「错误」的数据库条；不断言绝对分数，断言相对排序）。
    const hits = await store.searchFactsVector('ws-vec', vecOf('密码 错误 登录'))
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].match).toBe('vector')
    expect(hits[0].content).toContain('登录')
    expect(hits[0].score).toBeGreaterThan(0) // 共享字符 → 正余弦
  })

  it('searchHybrid merges keyword + vector via RRF; match=rrf', async () => {
    await store.addFact({ workspaceId: 'ws-hy', subject: '环境', predicate: '是', object: 'win11' })
    await store.addFact({ workspaceId: 'ws-hy', subject: '语言', predicate: '用', object: 'typescript' })
    const list = await store.listFacts('ws-hy')
    for (const f of list) {
      await store.addFactEmbedding({ factId: f.factId, workspaceId: 'ws-hy', content: f.content, vector: vecOf(f.content), model: 'fake' })
    }
    const hits = await store.searchHybrid('ws-hy', '环境', {
      embedQuery: async q => vecOf(q),
      limit: 5,
      model: 'fake',
    })
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].match).toBe('rrf')
    expect(hits[0].content).toContain('环境')
  })

  it('searchHybrid degrades to keyword-only when embedQuery throws', async () => {
    await store.addFact({ workspaceId: 'ws-hy-fail', subject: '登录', predicate: '报错', object: '超时' })
    const hits = await store.searchHybrid('ws-hy-fail', '登录', {
      embedQuery: async () => { throw new Error('embedding down') },
      limit: 5,
    })
    expect(hits.length).toBe(1)
    expect(hits[0].content).toContain('登录')
  })

  it('removeFactEmbedding deletes by ref', async () => {
    const fact = await store.addFact({ workspaceId: 'ws-delvec', subject: 'A', predicate: '关于', object: 'B' })
    await store.addFactEmbedding({ factId: fact!.factId, workspaceId: 'ws-delvec', content: fact!.content, vector: vecOf('AB'), model: 'fake' })
    expect((await store.searchFactsVector('ws-delvec', vecOf('AB'))).length).toBe(1)
    await store.removeFactEmbedding(fact!.factId)
    expect((await store.searchFactsVector('ws-delvec', vecOf('AB'))).length).toBe(0)
  })
})
