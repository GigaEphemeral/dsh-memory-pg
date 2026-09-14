import { describe, expect, it } from 'vitest'
import {
  distill,
  parseDistilledFacts,
  splitContext,
  normKey,
  DISTILL_SYSTEM_PROMPT,
} from '../src/distill.ts'

describe('parseDistilledFacts', () => {
  it('parses clean JSON', () => {
    const facts = parseDistilledFacts(
      '{"facts":[{"subject":"用户","predicate":"偏好","object":"简洁回复","content":"用户偏好简洁回复","tags":["偏好"]}]}',
    )
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toBe('用户偏好简洁回复')
    expect(facts[0].tags).toEqual(['偏好'])
  })

  it('strips code fences (level 2)', () => {
    const facts = parseDistilledFacts('```json\n{"facts":[{"subject":"A","predicate":"是","object":"B"}]}\n```')
    expect(facts).toHaveLength(1)
    expect(facts[0].content).toContain('A')
  })

  it('recovers balanced object from prose (level 3)', () => {
    const facts = parseDistilledFacts(
      '提炼结果如下 {"facts":[{"subject":"X","predicate":"依赖","object":"Y"}]} 完毕',
    )
    expect(facts).toHaveLength(1)
    expect(facts[0].predicate).toBe('依赖')
  })

  it('returns [] for garbage', () => {
    expect(parseDistilledFacts('no json here')).toEqual([])
    expect(parseDistilledFacts('')).toEqual([])
  })
})

describe('splitContext', () => {
  it('chunks long paragraphs and packs short lines', () => {
    const text = ['a'.repeat(250), '', 'b'.repeat(10), 'c'.repeat(10)].join('\n')
    const chunks = splitContext(text, { chunkChars: 200, maxChunks: 10, maxFacts: 10 })
    // a 超 200 → 硬切 2 段（200/50）；b/c 打包成一段 → 共 3
    expect(chunks.length).toBe(3)
  })

  it('caps chunk count at maxChunks', () => {
    const text = Array.from({ length: 10 }, (_, i) => `line${i} ${'x'.repeat(30)}`).join('\n')
    const chunks = splitContext(text, { chunkChars: 20, maxChunks: 3, maxFacts: 10 })
    expect(chunks.length).toBeLessThanOrEqual(3)
  })
})

describe('distill', () => {
  it('merges chunks and dedupes by norm key', async () => {
    const caller = async (): Promise<string> =>
      '{"facts":[{"subject":"A","predicate":"是","object":"B"}]}'
    const facts = await distill('some context', caller, { chunkChars: 1000, maxChunks: 3, maxFacts: 8 })
    expect(facts).toHaveLength(1)
    expect(facts[0].subject).toBe('A')
  })

  it('respects maxFacts', async () => {
    const caller = async (): Promise<string> =>
      '{"facts":[{"subject":"A","predicate":"p","object":"1"},{"subject":"B","predicate":"p","object":"2"}]}'
    const facts = await distill('ctx', caller, { chunkChars: 1000, maxChunks: 2, maxFacts: 1 })
    expect(facts).toHaveLength(1)
  })
})

describe('normKey / DISTILL_SYSTEM_PROMPT', () => {
  it('normalizes case/whitespace/punct', () => {
    expect(normKey('用户 偏好 简洁回复。')).toBe(normKey('用户偏好简洁回复'))
  })
  it('prompt mentions facts JSON shape', () => {
    expect(DISTILL_SYSTEM_PROMPT).toContain('facts')
  })
  it('absorbs official compaction prompt discipline (D-M3-2)', () => {
    // 吸纳官方：保留精确内容（路径/命令/错误串/标识符/数值）；忠实记录用户纠正/偏好
    expect(DISTILL_SYSTEM_PROMPT).toContain('文件路径')
    expect(DISTILL_SYSTEM_PROMPT).toContain('错误信息')
    expect(DISTILL_SYSTEM_PROMPT).toContain('标识符')
    expect(DISTILL_SYSTEM_PROMPT).toContain('忠实记录')
    expect(DISTILL_SYSTEM_PROMPT).toContain('纠正')
  })
})
