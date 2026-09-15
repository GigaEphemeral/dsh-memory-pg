import { describe, expect, it } from 'vitest'
import { rrfMerge, RRF_K_DEFAULT, type RankedSource } from '../src/rrf.ts'

describe('rrfMerge', () => {
  it('single source keeps rank order', () => {
    const src: Array<RankedSource<number>> = [{ rank: 1, item: 10 }, { rank: 2, item: 20 }, { rank: 3, item: 30 }]
    const out = rrfMerge([src])
    expect(out.map(r => r.item)).toEqual([10, 20, 30])
    expect(out[0].rrfScore).toBeGreaterThan(out[1].rrfScore)
    expect(out[0].sources).toBe(1)
  })

  it('two sources: item ranked in both outranks single-source items (k=60)', () => {
    // A 在关键词源排第 5、向量源排第 5 → 2/(60+5) = 2/65 ≈ 0.0308
    // B 只在关键词源排第 1 → 1/61 ≈ 0.0164
    // A 应胜出（双来源命中 > 单来源第一）
    const kw: Array<RankedSource<string>> = [
      { rank: 1, item: 'B' },
      { rank: 5, item: 'A' },
    ]
    const vec: Array<RankedSource<string>> = [
      { rank: 5, item: 'A' },
    ]
    const out = rrfMerge([kw, vec])
    expect(out[0].item).toBe('A')
    expect(out[0].sources).toBe(2)
    expect(out[0].ranks).toEqual([5, 5])
    expect(out[1].item).toBe('B')
  })

  it('empty sources returns empty', () => {
    expect(rrfMerge([])).toEqual([])
  })

  it('custom key groups by keyOf identity', () => {
    const kw: Array<RankedSource<{ id: number }>> = [{ rank: 1, item: { id: 1 } }]
    const vec: Array<RankedSource<{ id: number }>> = [{ rank: 2, item: { id: 1 } }]
    const out = rrfMerge([kw, vec], RRF_K_DEFAULT, item => item.id)
    expect(out).toHaveLength(1)
    expect(out[0].sources).toBe(2)
  })
})
