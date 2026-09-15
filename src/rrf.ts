/**
 * dsh-memory-pg 检索合并（F-14，M5）：RRF（Reciprocal Rank Fusion）。
 *
 * 当向量检索开启时，关键词检索（searchFacts）与向量检索（searchFactsVector）
 * 各产出一份排序列表，RRF 按 rank 合并：
 *   rrfScore(d) = Σ_sources 1 / (k + rank_s(d))
 * 默认 k = 60（task.md F-14 指定）。纯函数，可独立单测。
 */

export const RRF_K_DEFAULT = 60

/** 一份检索来源的排序命中（只要 id + rank；来源内 score 不参与 RRF）。 */
export interface RankedSource<T> {
  /** 来源内排序序号（1-based；越靠前 rank 越小）。 */
  rank: number
  item: T
}

/** RRF 合并结果。 */
export interface RrfResult<T> {
  item: T
  /** 合并得分 = Σ 1/(k+rank)；越高越相关。 */
  rrfScore: number
  /** 命中来源数（1 = 单来源命中；2 = 双来源命中，即关键词+向量都召回）。 */
  sources: number
  /** 各来源的 rank（按来源顺序）。 */
  ranks: number[]
}

/**
 * 多来源 rank 列表 → RRF 合并（按 rrfScore 降序）。
 * @param sources - 每个来源一个「rank → item」列表（来源内已按 rank 升序）。
 * @param k - RRF 常数（默认 60）。
 * @param keyOf - item 唯一键（默认用 item 自身 === 比较；跨来源同一条记忆须返回相同键）。
 */
export function rrfMerge<T>(
  sources: Array<ReadonlyArray<RankedSource<T>>>,
  k: number = RRF_K_DEFAULT,
  keyOf: (item: T) => unknown = item => item as unknown,
): RrfResult<T>[] {
  const kk = Number.isFinite(k) && k > 0 ? k : RRF_K_DEFAULT
  const map = new Map<unknown, { item: T; rrfScore: number; ranks: number[] }>()
  for (const source of sources) {
    source.forEach((entry, index) => {
      const key = keyOf(entry.item)
      const rank = entry.rank > 0 ? entry.rank : index + 1
      const existing = map.get(key)
      if (existing === undefined) {
        map.set(key, { item: entry.item, rrfScore: 1 / (kk + rank), ranks: [rank] })
      } else {
        existing.rrfScore += 1 / (kk + rank)
        existing.ranks.push(rank)
      }
    })
  }
  return [...map.values()]
    .map(entry => ({
      item: entry.item,
      rrfScore: entry.rrfScore,
      sources: entry.ranks.length,
      ranks: entry.ranks,
    }))
    .sort((a, b) => b.rrfScore - a.rrfScore)
}
