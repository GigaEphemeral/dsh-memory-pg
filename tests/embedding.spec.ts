import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { createServer, type Server } from 'node:http'
import { EmbeddingClient, EmbeddingError, normalizeVector, cosineScore } from '../src/embedding.ts'

/**
 * embedding 单测：本地 fake HTTP server（README §8.3 方案），返回确定性向量。
 * - 维度 = DIM；输入文本首字符 ASCII 码种子的 unit 向量（同文本同向量、不同文本不同向量）。
 * - /embeddings 收到 { model, input }；可选鉴权校验。
 */
const DIM = 8

function seedVector(text: string): number[] {
  const seed = [...String(text)].reduce((acc, ch) => (acc * 31 + ch.codePointAt(0)!) >>> 0, 7)
  // 确定性伪随机（线性同余），然后归一化为 unit 向量。
  let s = seed
  const raw: number[] = []
  for (let i = 0; i < DIM; i += 1) {
    s = (s * 1103515245 + 12345) >>> 0
    raw.push((s % 1000) / 1000)
  }
  return [...normalizeVector(raw)]
}

const requests: Array<{ model?: unknown; input?: unknown; auth?: string; path?: string }> = []

let server: Server
let baseUrl = ''

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += String(chunk) })
    req.on('end', () => {
      requests.push({ model: undefined, input: undefined, auth: req.headers.authorization, path: req.url })
      try {
        const payload = JSON.parse(body)
        requests[requests.length - 1].model = payload.model
        requests[requests.length - 1].input = payload.input
        const inputs = Array.isArray(payload.input) ? payload.input as string[] : []
        const data = inputs.map((text: string) => ({ embedding: seedVector(String(text)) }))
        res.statusCode = 200
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ data }))
      } catch {
        res.statusCode = 400
        res.end(JSON.stringify({ error: { message: 'bad request' } }))
      }
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('no port')
  // 完整端点 URL（含 /v1/embeddings 路径）——客户端不补路径，直接请求该 URL。
  baseUrl = `http://127.0.0.1:${addr.port}/v1/embeddings`
})

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve())))
})

describe('EmbeddingClient', () => {
  it('embedOne returns normalized vector of configured dim', async () => {
    requests.length = 0
    const client = new EmbeddingClient({ baseUrl, model: 'bge-m3', dim: DIM })
    const v = await client.embedOne('用户偏好简洁回复')
    expect(v.length).toBe(DIM)
    // 归一化：模 ≈ 1
    const norm = Math.sqrt([...v].reduce((s, x) => s + x * x, 0))
    expect(norm).toBeCloseTo(1, 5)
    // 请求格式：POST 完整端点 URL（客户端不补路径）{ model, input }
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe('/v1/embeddings')
    expect(requests[0].model).toBe('bge-m3')
    expect(requests[0].input).toEqual(['用户偏好简洁回复'])
  })

  it('embedMany batches; deterministic same-text same-vector', async () => {
    requests.length = 0
    const client = new EmbeddingClient({ baseUrl, model: 'bge-m3', dim: DIM, batchSize: 2 })
    const texts = ['甲', '乙', '丙', '丁']
    const vectors = await client.embedMany(texts)
    expect(vectors).toHaveLength(4)
    // batchSize=2 → 2 个请求
    expect(requests).toHaveLength(2)
    expect(requests[0].input).toEqual(['甲', '乙'])
    expect(requests[1].input).toEqual(['丙', '丁'])
    // 同文本同向量
    const again = await client.embedOne('甲')
    expect([...vectors[0]]).toEqual([...again])
    // 不同文本不同向量
    const other = await client.embedOne('完全不同的一段')
    expect([...vectors[0]]).not.toEqual([...other])
  })

  it('empty input returns []', async () => {
    const client = new EmbeddingClient({ baseUrl, model: 'bge-m3', dim: DIM })
    expect(await client.embedMany([])).toEqual([])
    expect(await client.embedMany(['  '])).toEqual([])
  })

  it('dimension mismatch throws EmbeddingError (README §2.2⑥ 维度不匹配显式报错)', async () => {
    // server 返回 DIM 维，客户端期望 dim=16 → 不匹配抛错
    const client = new EmbeddingClient({ baseUrl, model: 'bge-m3', dim: 16 })
    await expect(client.embedOne('x')).rejects.toThrow(EmbeddingError)
    await expect(client.embedOne('x')).rejects.toThrow(/dimension mismatch: got 8, expected 16/)
  })

  it('non-2xx endpoint surfaces error message', async () => {
    // 用一个不存在的端口 → connection refused → EmbeddingError
    const client = new EmbeddingClient({ baseUrl: 'http://127.0.0.1:1', model: 'bge-m3', dim: DIM })
    await expect(client.embedOne('x')).rejects.toThrow(EmbeddingError)
  })

  it('empty baseUrl/model/dim rejected at construction', () => {
    expect(() => new EmbeddingClient({ baseUrl: '', model: 'm', dim: 8 })).toThrow(/baseUrl/)
    expect(() => new EmbeddingClient({ baseUrl: 'http://x', model: '', dim: 8 })).toThrow(/model/)
    expect(() => new EmbeddingClient({ baseUrl: 'http://x', model: 'm', dim: 0 })).toThrow(/dim/)
  })
})

describe('normalizeVector / cosineScore', () => {
  it('normalizeVector produces unit vector; zero vector unchanged', () => {
    const unit = normalizeVector([3, 4])
    // Float32Array 精度：0.6 存为 0.6000000238418579，用 toBeCloseTo 而非 toEqual
    expect(unit[0]).toBeCloseTo(0.6, 5)
    expect(unit[1]).toBeCloseTo(0.8, 5)
    const norm = Math.sqrt(Number(unit[0]) ** 2 + Number(unit[1]) ** 2)
    expect(norm).toBeCloseTo(1, 5)
    const zero = normalizeVector([0, 0])
    expect([...zero]).toEqual([0, 0])
  })

  it('cosineScore of identical normalized vectors = 1, orthogonal = 0', () => {
    expect(cosineScore([1, 0], [1, 0])).toBeCloseTo(1, 6)
    expect(cosineScore([1, 0], [0, 1])).toBeCloseTo(0, 6)
    // 维度不一致 → 0
    expect(cosineScore([1], [1, 0])).toBe(0)
  })
})
