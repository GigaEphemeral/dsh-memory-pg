/**
 * dsh-memory-pg 检索后 LLM 重排（§3.5 主路径）。
 *
 * 设计：rerank 是**纯函数**——接收候选列表 + 查询 + 一个 scorer，返回重排后的候选。
 * scorer 由调用方注入（真实实现走 ctx.llm，测试注入 mock），使本模块可独立单测。
 */
import type { SearchHit } from './store.ts'

/** LLM 相关性打分器：给 (query, hit) 打分，越高越相关。 */
export type RelevanceScorer = (query: string, hit: SearchHit) => number | Promise<number>

/**
 * 用 LLM 打分重排关键词召回结果。
 * - 候选为空/查询为空 → 原样返回。
 * - scorer 注入（默认 = 用关键词分数兜底，无 LLM 时退化为原序）。
 * - 返回按 score 降序的新数组；不改入参。
 */
export async function rerankHits(
  query: string,
  hits: SearchHit[],
  scorer: RelevanceScorer | null = null,
): Promise<SearchHit[]> {
  const q = String(query ?? '').trim()
  if (!q || hits.length === 0) return hits
  if (scorer === null) return hits
  const scored: Array<{ hit: SearchHit; score: number }> = []
  for (const hit of hits) {
    const s = await scorer(q, hit)
    scored.push({ hit, score: Number.isFinite(s) ? s : 0 })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map(entry => entry.hit)
}

/**
 * 默认打分：在关键词分数基础上给标签/重要性加分（无 LLM 时的启发式重排）。
 * 避免完全依赖 LLM；作为 scorer=null 时的兜底排序。
 */
export function heuristicScore(query: string, hit: SearchHit): number {
  let score = hit.kwScore ?? hit.score ?? 0
  // 标签命中加权
  const q = String(query ?? '').toLowerCase()
  for (const tag of hit.tags) {
    if (tag && q.includes(tag.toLowerCase())) score += 0.15
  }
  // 重要性加权（0–10 → 最多 +0.1）
  if (typeof hit.importance === 'number' && Number.isFinite(hit.importance)) {
    score += hit.importance / 100
  }
  return score
}
