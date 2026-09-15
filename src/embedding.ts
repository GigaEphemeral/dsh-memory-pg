/**
 * dsh-memory-pg embedding 客户端（F-14，M5）。
 *
 * OpenAI 兼容 /embeddings 端点（Ollama 可用）：POST {baseUrl}/embeddings
 * { model, input } → { data: [{ embedding: number[] }] }。
 *
 * 设计：
 * - 纯 HTTP 客户端，不依赖 DSH 运行时（host 侧真实 npm bundle 有全局 fetch）。
 * - 维度校验（README §2.2⑥ 第 5 点）：返回向量维度必须 == 配置 vectorDim，
 *   否则显式报错（换 embedding 模型导致维度不匹配时写入静默失败的坑）。
 * - 向量归一化（cosine 相似度对归一化向量 = 点积），与参考实现 normalizeVector 同构。
 *
 * M5 范围（task.md F-14）：embedding 客户端 + 维度校验；写入/检索/RRF 接线见
 * store.ts / commands.ts / index.ts。
 */

/** embedding 客户端配置。 */
export interface EmbeddingConfig {
  /** OpenAI 兼容端点根 URL（如 http://localhost:11434） */
  baseUrl: string
  /** 模型名（如 bge-m3） */
  model: string
  /** 期望向量维度（bge-m3 = 1024）；返回维度不一致时报错 */
  dim: number
  /** 批量请求大小（默认 8） */
  batchSize?: number
  /** 请求超时 ms（默认 15_000） */
  timeoutMs?: number
  /** 可选 Bearer token（Ollama 不需要；OpenAI 兼容网关可能需要） */
  apiKey?: string
}

export const EMBEDDING_DEFAULTS = {
  batchSize: 8,
  timeoutMs: 15_000,
} as const

/** embedding 错误（含 HTTP 状态与端点消息）。 */
export class EmbeddingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'EmbeddingError'
  }
}

/**
 * OpenAI 兼容 embedding 客户端。
 * embedMany：分批 POST，返回归一化 Float32Array 向量数组；任一批失败即抛 EmbeddingError。
 */
export class EmbeddingClient {
  readonly baseUrl: string
  readonly model: string
  readonly dim: number
  private readonly batchSize: number
  private readonly timeoutMs: number
  private readonly apiKey: string | undefined

  constructor(config: EmbeddingConfig) {
    this.baseUrl = String(config.baseUrl ?? '').trim().replace(/\/+$/, '')
    this.model = String(config.model ?? '').trim()
    this.dim = Math.round(Number(config.dim) || 0)
    this.batchSize = Math.max(1, Math.round(Number(config.batchSize) || EMBEDDING_DEFAULTS.batchSize))
    this.timeoutMs = Math.max(1_000, Math.round(Number(config.timeoutMs) || EMBEDDING_DEFAULTS.timeoutMs))
    this.apiKey = config.apiKey?.trim() || undefined
    if (!this.baseUrl) throw new EmbeddingError('embedding baseUrl is empty')
    if (!this.model) throw new EmbeddingError('embedding model is empty')
    if (this.dim <= 0) throw new EmbeddingError('embedding dim must be a positive integer')
  }

  /** 单条文本 → 归一化向量（维度校验：与 dim 不一致时报错）。空文本抛 EmbeddingError。 */
  async embedOne(text: string): Promise<Float32Array> {
    const vectors = await this.embedMany([text])
    if (vectors.length === 0) throw new EmbeddingError('embedding input text is empty')
    return vectors[0]
  }

  /** 多条文本 → 归一化向量数组。空输入返回 []。 */
  async embedMany(texts: readonly string[]): Promise<Float32Array[]> {
    const inputs = texts.map(t => String(t ?? '').trim()).filter(Boolean)
    if (inputs.length === 0) return []
    const out: Float32Array[] = []
    for (let i = 0; i < inputs.length; i += this.batchSize) {
      const batch = inputs.slice(i, i + this.batchSize)
      const vectors = await this.postBatch(batch)
      for (const v of vectors) {
        assertDim(v, this.dim)
        out.push(normalizeVector(v))
      }
    }
    return out
  }

  /** 单批 POST {baseUrl}/embeddings。 */
  private async postBatch(batch: string[]): Promise<number[][]> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new EmbeddingError('embedding request timeout')), this.timeoutMs)
    try {
      let response: Response
      try {
        response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey !== undefined ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: this.model, input: batch }),
          signal: controller.signal,
        })
      } catch (error) {
        if (error instanceof EmbeddingError) throw error
        throw new EmbeddingError(`embedding endpoint unreachable: ${error instanceof Error ? error.message : String(error)}`)
      }
      const payload = await response.json().catch(() => ({}))
      if (!response.ok) {
        const message = (payload as { error?: { message?: string }; message?: string })?.error?.message
          ?? (payload as { message?: string })?.message
          ?? 'unknown error'
        throw new EmbeddingError(`embedding endpoint ${this.baseUrl} returned ${response.status}: ${message}`, response.status)
      }
      const data = Array.isArray((payload as { data?: unknown })?.data) ? (payload as { data: Array<{ embedding?: unknown }> }).data : []
      if (data.length !== batch.length) {
        throw new EmbeddingError(`embedding endpoint returned ${data.length} vectors for ${batch.length} input(s)`)
      }
      const vectors: number[][] = []
      for (let i = 0; i < batch.length; i += 1) {
        const raw = data[i]?.embedding
        if (!Array.isArray(raw) || raw.length === 0) {
          throw new EmbeddingError(`embedding endpoint returned an empty vector for input #${i + 1}`)
        }
        vectors.push(raw.map(Number))
      }
      return vectors
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 维度断言：v.length == dim，否则显式报错（§2.2⑥ 维度不匹配的坑）。 */
export function assertDim(vector: ArrayLike<number>, dim: number): void {
  if (vector.length !== dim) {
    throw new EmbeddingError(`embedding dimension mismatch: got ${vector.length}, expected ${dim} (检查 embedding 模型与配置维度是否一致)`)
  }
}

/** L2 归一化（cosine 相似度对归一化向量 = 点积）。零向量原样返回。 */
export function normalizeVector(vector: ArrayLike<number>): Float32Array {
  const v = vector instanceof Float32Array ? vector : new Float32Array(vector)
  let sum = 0
  for (let i = 0; i < v.length; i += 1) sum += v[i] * v[i]
  const norm = Math.sqrt(sum)
  if (!Number.isFinite(norm) || norm === 0) return v
  const out = new Float32Array(v.length)
  for (let i = 0; i < v.length; i += 1) out[i] = v[i] / norm
  return out
}

/** cosine 相似度（对归一化向量即点积）；维度不一致返回 0。 */
export function cosineScore(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i += 1) dot += a[i] * b[i]
  return Math.max(0, dot)
}
