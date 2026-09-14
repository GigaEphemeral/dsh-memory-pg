/**
 * dsh-memory-pg 存储层：PG 连接池 + 健康检查 + CRUD + 关键词检索。
 *
 * M2 落地 README §16.1（软删除/取代链/去重语义）与 §4.3（四表结构）。
 * 业务语义照搬 dsh-local-vector-memory/lib/store.mjs，存储后端换 PostgreSQL。
 * v1 聚焦 messages + facts 两表写入；ltm_entries / embeddings 表已建，写入路径后续里程碑启用。
 */
import pg, { type Pool, type PoolClient } from 'pg'
import { SCHEMA_SQL, EXTENSION_SQL } from './schema.ts'
import { rerankHits, heuristicScore, type RelevanceScorer } from './rerank.ts'

/** 数据库连接配置（来自设置面板）。 */
export interface DbConfig {
  host: string
  port: number
  user: string
  password: string
  database: string
}

/** 一条事实（facts 行，三要素 + 状态）。 */
export interface FactRecord {
  factId: number
  workspaceId: string
  sessionId: string | null
  subject: string
  predicate: string
  object: string
  content: string
  kind: string
  tags: string[]
  importance: number | null
  confidence: number | null
  status: string
  version: number
  supersededBy: number | null
  sourceMessageIds: number[]
  contentHash: string
  createdAt: string
  updatedAt: string
  deletedAt: string | null
}

/** 新增事实的输入。 */
export interface FactInput {
  workspaceId: string
  sessionId?: string | null
  subject: string
  predicate: string
  object: string
  content?: string
  kind?: string
  tags?: string[]
  importance?: number | null
  confidence?: number | null
  sourceMessageIds?: number[]
}

/** 关键词检索命中（facts + 匹配方式）。 */
export interface SearchHit extends FactRecord {
  score: number
  match: 'keyword' | 'tag' | 'rrf'
  kwScore?: number | null
}

/** 连接测试分项。 */
export interface HealthStep {
  name: string
  ok: boolean
  detail?: string
}

/** 连接测试结果。 */
export interface HealthResult {
  ok: boolean
  steps: HealthStep[]
}

/** 关键词打分：与参考实现 keywordScore 同构（CJK 二元组近似）。 */
export function keywordScore(memoryText: string, query: string): number {
  const text = String(memoryText || '').toLowerCase()
  const q = String(query || '').toLowerCase()
  const terms = new Set<string>()
  for (const raw of q.split(/[^0-9a-z\u3400-\u9fff]+/i)) {
    if (raw.length >= 2) terms.add(raw)
  }
  const cjkRuns = q.match(/[\u3400-\u9fff]{2,}/g) || []
  for (const run of cjkRuns) {
    if (run.length <= 4) terms.add(run)
    for (let i = 0; i + 2 <= run.length && run.length > 4; i += 1) terms.add(run.slice(i, i + 2))
  }
  if (terms.size === 0) return 0
  let hits = 0
  for (const term of terms) if (text.includes(term)) hits += 1
  return hits / terms.size
}

/** 归一化 content → content_hash（精确去重键）。 */
export function contentHashOf(content: string): string {
  // 去空白/标点后的小写字符串；与参考实现 normalizeTags 的去重思路一致。
  return String(content || '').toLowerCase().replace(/[\s\u3000\p{P}\p{S}]+/gu, '')
}

export class MemoryStore {
  private pool: Pool | null = null

  /** 建立连接池（懒：不立即 connect；首次查询时才连）。 */
  connect(config: DbConfig): void {
    this.pool = new pg.Pool({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      // 连接启动即固定 public，避免继承库级 search_path 里的 ag_catalog 等 AGE 残留 schema
      // （README §2.2⑤ 的 AGE + 连接池已知坑）。
      options: '-c search_path=public',
    })
  }

  private poolOf(): Pool {
    if (this.pool === null) throw new Error('memory store: not connected; call connect(config) first')
    return this.pool
  }

  /** 关闭连接池。 */
  async close(): Promise<void> {
    if (this.pool !== null) {
      await this.pool.end().catch(() => {})
      this.pool = null
    }
  }

  /** 建扩展 + 建表（幂等迁移）。 */
  async migrate(): Promise<void> {
    const client = await this.poolOf().connect()
    try {
      await client.query(EXTENSION_SQL)
      await client.query(SCHEMA_SQL)
    } finally {
      client.release()
    }
  }

  /** 测试辅助：清空数据表（保留表结构），供单测隔离。 */
  async truncateAll(): Promise<void> {
    await this.poolOf().query('TRUNCATE messages, facts, ltm_entries, embeddings RESTART IDENTITY')
  }

  /** 健康检查：逐项（connect / pgvector / schema）。 */
  async health(config: DbConfig): Promise<HealthResult> {
    const steps: HealthStep[] = []
    let client: PoolClient
    try {
      client = await new pg.Pool({
        host: config.host,
        port: config.port,
        user: config.user,
        password: config.password,
        database: config.database,
        connectionTimeoutMillis: 5_000,
        options: '-c search_path=public',
      }).connect()
    } catch (error) {
      steps.push({ name: 'connect', ok: false, detail: error instanceof Error ? error.message : String(error) })
      return { ok: false, steps }
    }
    try {
      const r = await client.query<{ extversion: string }>(
        `SELECT extversion FROM pg_extension WHERE extname = 'vector'`,
      )
      steps.push({
        name: 'pgvector',
        ok: r.rowCount !== null && r.rowCount > 0,
        detail: r.rows[0]?.extversion ?? 'vector 扩展未安装',
      })
    } catch (error) {
      steps.push({ name: 'pgvector', ok: false, detail: String(error) })
    }
    try {
      const r = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'facts') AS exists`,
      )
      steps.push({
        name: 'schema',
        ok: r.rows[0]?.exists === true,
        detail: r.rows[0]?.exists ? 'facts 表存在' : 'facts 表不存在（未迁移）',
      })
    } catch (error) {
      steps.push({ name: 'schema', ok: false, detail: String(error) })
    }
    client.release()
    return { ok: steps.every(s => s.ok), steps }
  }

  // ── facts CRUD ────────────────────────────────────────────────

  /** 新增一条事实。content 缺省由三要素合成；content_hash 精确去重。 */
  async addFact(input: FactInput): Promise<FactRecord | null> {
    const content = (input.content ?? '').trim()
      || `${input.subject} ${input.predicate} ${input.object}`.trim()
    if (!content) throw new Error('fact content is empty')
    const hash = contentHashOf(content)
    const client = await this.poolOf().connect()
    try {
      const existing = await client.query<{ fact_id: number }>(
        `SELECT fact_id FROM facts WHERE workspace_id = $1 AND content_hash = $2 AND deleted_at IS NULL`,
        [input.workspaceId, hash],
      )
      if (existing.rowCount && existing.rowCount > 0) {
        return this.getFactById(Number(existing.rows[0].fact_id))
      }
      const r = await client.query<{ fact_id: number }>(
        `INSERT INTO facts
          (workspace_id, session_id, subject, predicate, object, content, kind, tags, importance, confidence, source_message_ids, content_hash)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING fact_id`,
        [
          input.workspaceId,
          input.sessionId ?? null,
          input.subject,
          input.predicate,
          input.object,
          content,
          input.kind ?? 'fact',
          input.tags ?? [],
          input.importance ?? null,
          input.confidence ?? null,
          input.sourceMessageIds ?? [],
          hash,
        ],
      )
      return this.getFactById(Number(r.rows[0].fact_id))
    } finally {
      client.release()
    }
  }

  /** 按 id 读取事实（排除软删除）。 */
  async getFactById(id: number): Promise<FactRecord | null> {
    const r = await this.poolOf().query(`SELECT * FROM facts WHERE fact_id = $1 AND deleted_at IS NULL`, [id])
    return r.rowCount ? rowToFact(r.rows[0]) : null
  }

  /** 列出某 workspace 的事实（可按 tag / kind 过滤；默认排除软删除与取代链）。 */
  async listFacts(
    workspaceId: string,
    opts: { tag?: string; kind?: string; includeDeleted?: boolean; includeSuperseded?: boolean; limit?: number } = {},
  ): Promise<FactRecord[]> {
    const clauses = ['workspace_id = $1']
    const params: unknown[] = [workspaceId]
    if (!opts.includeDeleted) clauses.push('deleted_at IS NULL')
    if (!opts.includeSuperseded) clauses.push("status <> 'superseded'")
    if (opts.tag) { params.push(opts.tag); clauses.push(`$${params.length} = ANY(tags)`) }
    if (opts.kind) { params.push(opts.kind); clauses.push(`$${params.length} = kind`) }
    params.push(opts.limit ?? 50)
    const r = await this.poolOf().query(
      `SELECT * FROM facts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    )
    return r.rows.map(rowToFact)
  }

  /** 软删除一条事实（deleted_at 标记，可恢复）。 */
  async softDeleteFact(id: number): Promise<boolean> {
    const r = await this.poolOf().query(
      `UPDATE facts SET deleted_at = now(), updated_at = now() WHERE fact_id = $1 AND deleted_at IS NULL`,
      [id],
    )
    return (r.rowCount ?? 0) > 0
  }

  /** 恢复软删除的事实。 */
  async restoreFact(id: number): Promise<boolean> {
    const r = await this.poolOf().query(
      `UPDATE facts SET deleted_at = NULL, updated_at = now() WHERE fact_id = $1`,
      [id],
    )
    return (r.rowCount ?? 0) > 0
  }

  /** 标记旧事实被新事实取代（取代链，§3.4 冲突检测落点）。 */
  async supersedeFact(ids: number[], byId: number): Promise<number> {
    if (ids.length === 0) return 0
    const r = await this.poolOf().query(
      `UPDATE facts SET status = 'superseded', superseded_by = $2, updated_at = now()
       WHERE fact_id = ANY($1::bigint[]) AND deleted_at IS NULL`,
      [ids, byId],
    )
    return r.rowCount ?? 0
  }

  /** 更新事实文本/标签/重要性（可置 superseded 状态）。 */
  async updateFact(
    id: number,
    patch: { content?: string; tags?: string[]; importance?: number | null; status?: string },
  ): Promise<FactRecord | null> {
    const sets: string[] = ['updated_at = now()']
    const params: unknown[] = []
    if (patch.content !== undefined) { params.push(patch.content); sets.push(`content = $${params.length}`) }
    if (patch.tags !== undefined) { params.push(patch.tags); sets.push(`tags = $${params.length}`) }
    if (patch.importance !== undefined) { params.push(patch.importance); sets.push(`importance = $${params.length}`) }
    if (patch.status !== undefined) { params.push(patch.status); sets.push(`status = $${params.length}`) }
    params.push(id)
    await this.poolOf().query(`UPDATE facts SET ${sets.join(', ')} WHERE fact_id = $${params.length}`, params)
    return this.getFactById(id)
  }

  // ── 关键词检索（v1 主路径：trigram + 内存关键词打分 + LLM 重排交给 rerank） ──

  /**
   * 关键词检索（v1 主路径）：扫描 workspace 内有效事实，用 keywordScore（CJK 二元组感知）
   * 打分排序。参考实现同构——workspace 级记忆量小（几十~几百条），全表扫 + 内存打分足够
   * （README §3.5 论证），且 CJK 空格/分词比 ILIKE 初筛更稳。trigram 索引保留用于未来大库
   * 粗筛或 `/memory-pg-search` 的扩展。
   */
  async searchFacts(
    workspaceId: string,
    query: string,
    opts: { limit?: number; minScore?: number; tag?: string; kind?: string } = {},
  ): Promise<SearchHit[]> {
    const q = String(query ?? '').trim()
    if (!q) return []
    const clauses = ['workspace_id = $1', 'deleted_at IS NULL', "status <> 'superseded'"]
    const params: unknown[] = [workspaceId]
    if (opts.tag) { params.push(opts.tag); clauses.push(`$${params.length} = ANY(tags)`) }
    if (opts.kind) { params.push(opts.kind); clauses.push(`$${params.length} = kind`) }
    const r = await this.poolOf().query(`SELECT * FROM facts WHERE ${clauses.join(' AND ')}`, params)
    const minScore = opts.minScore ?? 0
    const hits: SearchHit[] = r.rows
      .map(rowToFact)
      .map((fact) => {
        const s = keywordScore(`${fact.content} ${fact.tags.join(' ')}`, q)
        return {
          ...fact,
          score: s,
          match: 'keyword' as const,
          kwScore: s,
        }
      })
      .filter(h => h.score >= minScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 20)
    return hits
  }

  /**
   * 组合入口：关键词检索 →（可选）LLM 重排。
   * scorer 缺省用 heuristicScore（无 LLM 时也有合理排序）；调用方可注入 ctx.llm scorer。
   */
  async searchAndRerank(
    workspaceId: string,
    query: string,
    opts: { limit?: number; minScore?: number; tag?: string; kind?: string; scorer?: RelevanceScorer | null } = {},
  ): Promise<SearchHit[]> {
    const hits = await this.searchFacts(workspaceId, query, opts)
    const scorer = opts.scorer === undefined ? (q: string, h: SearchHit) => heuristicScore(q, h) : opts.scorer
    return rerankHits(query, hits, scorer)
  }
}

// ── 行映射辅助 ──────────────────────────────────────────────────

interface FactRow {
  fact_id: number
  workspace_id: string
  session_id: string | null
  subject: string
  predicate: string
  object: string
  content: string
  kind: string
  tags: string[] | string
  importance: string | number | null
  confidence: string | number | null
  status: string
  version: number
  superseded_by: number | null
  source_message_ids: number[] | string
  content_hash: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

function rowToFact(row: FactRow): FactRecord {
  return {
    factId: Number(row.fact_id),
    workspaceId: String(row.workspace_id),
    sessionId: row.session_id ? String(row.session_id) : null,
    subject: String(row.subject),
    predicate: String(row.predicate),
    object: String(row.object),
    content: String(row.content),
    kind: String(row.kind),
    tags: Array.isArray(row.tags) ? row.tags.map(String) : (safeJsonArray(row.tags) as string[]),
    importance: row.importance === null ? null : Number(row.importance),
    confidence: row.confidence === null ? null : Number(row.confidence),
    status: String(row.status),
    version: Number(row.version),
    supersededBy: row.superseded_by === null ? null : Number(row.superseded_by),
    sourceMessageIds: Array.isArray(row.source_message_ids)
      ? row.source_message_ids.map(Number)
      : safeJsonArray(row.source_message_ids).map(Number),
    contentHash: String(row.content_hash),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    deletedAt: row.deleted_at ? String(row.deleted_at) : null,
  }
}

function safeJsonArray(value: string | unknown[]): unknown[] {
  if (Array.isArray(value)) return value
  try {
    const parsed = JSON.parse(String(value ?? '[]'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}
