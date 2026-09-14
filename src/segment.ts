/**
 * dsh-memory-pg 语义分割 + 去重 + 冲突检测（§3.3 / §3.4）。
 *
 * 纯函数模块（不碰 IO / 不碰 DSH），可独立单测。
 * - 分割：提炼产出即原子单元（方案 A）；过长（>maxChars）递归字符分割兜底；过短（<minChars）与相邻同类合并。
 * - 去重：精确（content_hash）+ 近似（相似度阈值）。
 * - 冲突：相似度在 conflictScore ~ dedupScore 之间 → 标记 pending_review，不静默覆盖。
 */
import type { DistilledFact } from './distill.ts'
import { normKey } from './distill.ts'

/** 分割/去重/冲突阈值配置。 */
export interface SegmentConfig {
  /** 单条事实过长阈值（字符），超过则递归分割 */
  maxChars: number
  /** 单条事实过短阈值（字符），低于则与相邻合并 */
  minChars: number
  /** 近似去重相似度阈值：>= 此值视为重复，跳过 */
  dedupScore: number
  /** 冲突检测相似度阈值：>= 此值（但 < dedupScore）标记待确认 */
  conflictScore: number
}

export const SEGMENT_DEFAULTS: SegmentConfig = {
  maxChars: 600,
  minChars: 20,
  dedupScore: 0.92,
  conflictScore: 0.86,
}

/** 相似度函数：v1 默认用关键词/Jaccard 近似（无向量时）；开向量后换真实余弦。 */
export type SimilarityFn = (a: string, b: string) => number

/**
 * Jaccard 相似度（按字符二元组）：短文本相似度的无向量近似。
 * 开向量后由调用方替换为 embedding 余弦（决策 D-M3-1）。
 */
export function jaccardSimilarity(a: string, b: string): number {
  const na = normKey(a)
  const nb = normKey(b)
  if (!na || !nb) return 0
  const setA = bigrams(na)
  const setB = bigrams(nb)
  if (setA.size === 0 || setB.size === 0) return 0
  let inter = 0
  for (const g of setA) if (setB.has(g)) inter += 1
  return inter / (setA.size + setB.size - inter)
}

function bigrams(text: string): Set<string> {
  const set = new Set<string>()
  for (let i = 0; i + 1 < text.length; i += 1) set.add(text.slice(i, i + 2))
  // 单字符（如英文单词边界）也加入，避免空集
  if (set.size === 0 && text.length === 1) set.add(text)
  return set
}

/** 一条分割/去重后的最终事实（待入库）。 */
export interface SegmentedFact {
  subject: string
  predicate: string
  object: string
  content: string
  tags: string[]
  importance: number | null
  confidence: number | null
  /** 精确去重键（content_hash 输入） */
  hash: string
  /** 状态：new（新增）/ duplicate（近似重复，跳过）/ conflict（冲突，标记待确认） */
  status: 'new' | 'duplicate' | 'conflict'
  /** 冲突时命中的已有 factId（由调用方回填） */
  conflictWith?: number
}

/**
 * 分割 + 精确去重。
 * - 过长 → 递归字符分割（保持句子完整，降级 `\n\n`→`\n`→句号）
 * - 过短 → 与相邻同类合并
 * - 每条产 content_hash（精确去重键）
 */
export function segmentFacts(facts: DistilledFact[], config: SegmentConfig = SEGMENT_DEFAULTS): SegmentedFact[] {
  const out: SegmentedFact[] = []
  const seen = new Set<string>()
  for (const fact of facts) {
    const pieces = splitLong(fact.content, config.maxChars)
    for (const piece of pieces) {
      const hash = normKey(piece)
      if (seen.has(hash)) continue
      seen.add(hash)
      out.push({
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        content: piece,
        tags: fact.tags,
        importance: fact.importance,
        confidence: fact.confidence,
        hash,
        status: 'new',
      })
    }
  }
  return mergeShort(out, config.minChars)
}

/** 过长 → 递归字符分割（`\n\n`→`\n`→句号→空格，保持语义完整）。 */
function splitLong(text: string, maxChars: number): string[] {
  const t = String(text ?? '').trim()
  if (t.length <= maxChars) return t ? [t] : []
  const out: string[] = []
  const seps: Array<[string, string]> = [
    ['\n\n', '\n'],
    ['\n', '。'],
    ['。', '；'],
    ['；', '，'],
  ]
  let pool = [t]
  let guard = 0
  while (pool.some(p => p.length > maxChars) && guard < 8) {
    guard += 1
    const next: string[] = []
    for (const p of pool) {
      if (p.length <= maxChars) { next.push(p); continue }
      const sep = seps.find(([s]) => p.includes(s))
      if (!sep) {
        // 无分隔符可切 → 硬切
        for (let i = 0; i < p.length; i += maxChars) next.push(p.slice(i, i + maxChars).trim())
        continue
      }
      const idx = p.lastIndexOf(sep[0], maxChars)
      if (idx <= 0) {
        next.push(p.slice(0, maxChars).trim(), p.slice(maxChars).trim())
      } else {
        next.push(p.slice(0, idx + sep[0].length).trim(), p.slice(idx + sep[0].length).trim())
      }
    }
    pool = next
  }
  out.push(...pool.filter(p => p))
  return out
}

/** 过短 → 与相邻同类合并（避免碎片污染检索）。 */
function mergeShort(facts: SegmentedFact[], minChars: number): SegmentedFact[] {
  const out: SegmentedFact[] = []
  for (const fact of facts) {
    const last = out[out.length - 1]
    if (fact.content.length < minChars && last !== undefined && last.status === 'new') {
      const merged = `${last.content} ${fact.content}`.trim()
      if (merged.length <= minChars * 3) {
        out[out.length - 1] = { ...last, content: merged, hash: normKey(merged) }
        continue
      }
    }
    out.push(fact)
  }
  return out
}

/**
 * 近似去重 + 冲突检测。
 * 对每条 new 事实，用 similarity 与已有事实集合比对：
 * - >= dedupScore → duplicate（跳过）
 * - conflictScore ~ dedupScore → conflict（标记 pending_review，返回 conflictWith）
 * 返回分类后的结果（duplicate 也返回，调用方决定跳过；conflict 由调用方标记 pending_review）。
 */
export function classifyDedup(
  facts: SegmentedFact[],
  existingContents: Array<{ factId: number; content: string }>,
  similarity: SimilarityFn = jaccardSimilarity,
  config: SegmentConfig = SEGMENT_DEFAULTS,
): SegmentedFact[] {
  return facts.map((fact) => {
    if (fact.status !== 'new') return fact
    let best = { id: -1, score: 0 }
    for (const ex of existingContents) {
      const s = similarity(fact.content, ex.content)
      if (s > best.score) best = { id: ex.factId, score: s }
    }
    if (best.id < 0) return fact
    if (best.score >= config.dedupScore) {
      return { ...fact, status: 'duplicate' as const, conflictWith: best.id }
    }
    if (best.score >= config.conflictScore) {
      return { ...fact, status: 'conflict' as const, conflictWith: best.id }
    }
    return fact
  })
}
