import { describe, expect, it } from 'vitest'
import { rerankHits, heuristicScore } from '../src/rerank.ts'
import type { SearchHit } from '../src/store.ts'

function hit(id: number, content: string, tags: string[] = [], importance: number | null = null): SearchHit {
  return {
    factId: id,
    workspaceId: 'ws',
    sessionId: null,
    subject: 's',
    predicate: 'p',
    object: 'o',
    content,
    kind: 'fact',
    tags,
    importance,
    confidence: null,
    status: 'active',
    version: 1,
    supersededBy: null,
    sourceMessageIds: [],
    contentHash: `h${id}`,
    createdAt: '',
    updatedAt: '',
    deletedAt: null,
    score: 0,
    match: 'keyword',
    kwScore: 0,
  }
}

describe('rerankHits', () => {
  it('returns input unchanged when query empty or hits empty', async () => {
    expect(await rerankHits('', [hit(1, 'x')])).toHaveLength(1)
    expect(await rerankHits('q', [])).toEqual([])
  })

  it('returns input unchanged when scorer is null', async () => {
    const hits = [hit(1, 'a'), hit(2, 'b')]
    expect(await rerankHits('q', hits, null)).toBe(hits)
  })

  it('sorts by scorer descending', async () => {
    const hits = [hit(1, 'a'), hit(2, 'b'), hit(3, 'c')]
    const out = await rerankHits('q', hits, async (_q, h) => h.factId * 10)
    expect(out.map(h => h.factId)).toEqual([3, 2, 1])
  })
})

describe('heuristicScore', () => {
  it('boosts tag hits and importance', () => {
    const a = hit(1, '登录 环境', ['编程'], 8)
    const b = hit(2, '登录 环境', [], null)
    const scoreA = heuristicScore('编程', a)
    const scoreB = heuristicScore('编程', b)
    expect(scoreA).toBeGreaterThan(scoreB)
  })
})
