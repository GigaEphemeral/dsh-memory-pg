import { describe, expect, it } from 'vitest'
import {
  segmentFacts,
  classifyDedup,
  jaccardSimilarity,
  SEGMENT_DEFAULTS,
} from '../src/segment.ts'
import type { DistilledFact } from '../src/distill.ts'

function fact(subject: string, object: string, content: string, tags: string[] = []): DistilledFact {
  return { subject, predicate: '是', object, content, tags, importance: null, confidence: null }
}

describe('segmentFacts', () => {
  it('splits overlong facts (> maxChars)', () => {
    const f = fact('A', 'B', 'x'.repeat(700))
    const seg = segmentFacts([f], SEGMENT_DEFAULTS)
    // 无分隔符 → 硬切，至少 2 段
    expect(seg.length).toBeGreaterThanOrEqual(2)
    expect(seg.every(s => s.status === 'new')).toBe(true)
  })

  it('dedupes exact duplicates by content hash', () => {
    const f1 = fact('A', 'B', '用户偏好简洁回复')
    const f2 = fact('A', 'B', '用户偏好简洁回复')
    const seg = segmentFacts([f1, f2], SEGMENT_DEFAULTS)
    expect(seg).toHaveLength(1)
  })

  it('merges short fragments with adjacent', () => {
    const f1 = fact('A', 'B', '简短')
    const f2 = fact('C', 'D', '另一条内容')
    const seg = segmentFacts([f1, f2], { ...SEGMENT_DEFAULTS, minChars: 20 })
    // 两条都短（<20）→ 合并为一条，内容拼接
    expect(seg).toHaveLength(1)
    expect(seg[0].content).toContain('简短')
    expect(seg[0].content).toContain('另一条内容')
  })
})

describe('classifyDedup', () => {
  it('marks exact-ish duplicate (>= dedupScore)', () => {
    const seg = segmentFacts([fact('A', 'B', '用户偏好简洁回复')], SEGMENT_DEFAULTS)
    const out = classifyDedup(
      seg,
      [{ factId: 1, content: '用户偏好简洁回复' }],
      jaccardSimilarity,
      SEGMENT_DEFAULTS,
    )
    // 完全相同 → Jaccard 1.0 >= 0.92 → duplicate
    expect(out[0].status).toBe('duplicate')
    expect(out[0].conflictWith).toBe(1)
  })

  it('marks near-duplicate as conflict (between thresholds)', () => {
    const seg = segmentFacts([fact('A', 'B', '用户偏好简洁回复且中文')], SEGMENT_DEFAULTS)
    const out = classifyDedup(
      seg,
      [{ factId: 7, content: '用户偏好简洁回复且中文' }],
      () => 0.9, // 0.86 <= 0.9 < 0.92
      SEGMENT_DEFAULTS,
    )
    expect(out[0].status).toBe('conflict')
    expect(out[0].conflictWith).toBe(7)
  })

  it('leaves distinct facts as new', () => {
    const seg = segmentFacts([fact('A', 'B', '登录bug排查')], SEGMENT_DEFAULTS)
    const out = classifyDedup(seg, [{ factId: 1, content: '娱乐电影推荐' }], jaccardSimilarity, SEGMENT_DEFAULTS)
    expect(out[0].status).toBe('new')
  })
})

describe('jaccardSimilarity', () => {
  it('returns 1 for identical, 0 for disjoint', () => {
    expect(jaccardSimilarity('abcde', 'abcde')).toBe(1)
    expect(jaccardSimilarity('aaaa', 'bbbb')).toBe(0)
  })
})
