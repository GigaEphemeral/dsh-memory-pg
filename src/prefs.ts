/**
 * dsh-memory-pg 用户偏好（设置面板命名空间）。
 *
 * 与 DSH-better-sidebar 的 prefs-shared 同模式：类型 + 常量 + 默认值独立成模块，
 * 同时被 host（注册 schema）与 client（读/写）引用，且不引 schemastery 运行时。
 */

/** 设置命名空间 = settings.register 的 ns = settings.section 列表项的 id。 */
export const SETTINGS_NS = 'dsh-memory-pg'

/** 用户可配置的数据库连接与 embedding 设置。 */
export interface MemoryPgPrefs {
  /** PostgreSQL 连接参数 */
  dbHost: string
  dbPort: number
  dbUser: string
  dbPassword: string
  dbName: string
  /** 连接测试：分项报告结果（前端展示用，非持久化语义字段） */
  lastTest?: {
    at: string
    ok: boolean
    steps: Array<{ name: string; ok: boolean; detail?: string }>
  }
  /** embedding（可选，默认关）：OpenAI 兼容**完整端点 URL**（含 /v1 前缀，如 Ollama） */
  embeddingBaseUrl: string
  /** embedding 模型名，默认 bge-m3 */
  embeddingModel: string
  /** 向量维度（bge-m3 = 1024），连接测试用它比对库中 vector 列 */
  vectorDim: number
  /** 是否启用向量检索（默认关，D7） */
  vectorEnabled: boolean
}

/** 默认值：本机环境事实（README §8.0） */
export const MEMORY_PG_PREFS_DEFAULTS: MemoryPgPrefs = {
  dbHost: 'localhost',
  dbPort: 54320,
  dbUser: 'postgres',
  dbPassword: '',
  dbName: 'dsh_memory_pg',
  embeddingBaseUrl: 'http://localhost:11434/v1/embeddings',
  embeddingModel: 'bge-m3',
  vectorDim: 1024,
  vectorEnabled: false,
}

/** 端口合法区间 */
export const DB_PORT_MIN = 1
export const DB_PORT_MAX = 65535
/** 向量维度合法区间 */
export const VECTOR_DIM_MIN = 1
export const VECTOR_DIM_MAX = 65535

/** 把任意值钳进区间（客户端校验用，与 schema 保持一致）。 */
export function clampInt(value: number, min: number, max: number, fallback: number): number {
  const n = Math.round(Number(value))
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, n))
}

/** 客户端防御性解析：逐字段校验 + 失败回退默认值（永不信任线缆值）。 */
export function parsePrefs(value: unknown): MemoryPgPrefs {
  if (value === null || typeof value !== 'object') return { ...MEMORY_PG_PREFS_DEFAULTS }
  const r = value as Record<string, unknown>
  return {
    dbHost: typeof r.dbHost === 'string' ? r.dbHost : MEMORY_PG_PREFS_DEFAULTS.dbHost,
    dbPort: typeof r.dbPort === 'number' && Number.isFinite(r.dbPort)
      ? clampInt(r.dbPort, DB_PORT_MIN, DB_PORT_MAX, MEMORY_PG_PREFS_DEFAULTS.dbPort)
      : MEMORY_PG_PREFS_DEFAULTS.dbPort,
    dbUser: typeof r.dbUser === 'string' ? r.dbUser : MEMORY_PG_PREFS_DEFAULTS.dbUser,
    dbPassword: typeof r.dbPassword === 'string' ? r.dbPassword : MEMORY_PG_PREFS_DEFAULTS.dbPassword,
    dbName: typeof r.dbName === 'string' ? r.dbName : MEMORY_PG_PREFS_DEFAULTS.dbName,
    embeddingBaseUrl: typeof r.embeddingBaseUrl === 'string'
      ? r.embeddingBaseUrl
      : MEMORY_PG_PREFS_DEFAULTS.embeddingBaseUrl,
    embeddingModel: typeof r.embeddingModel === 'string'
      ? r.embeddingModel
      : MEMORY_PG_PREFS_DEFAULTS.embeddingModel,
    vectorDim: typeof r.vectorDim === 'number' && Number.isFinite(r.vectorDim)
      ? clampInt(r.vectorDim, VECTOR_DIM_MIN, VECTOR_DIM_MAX, MEMORY_PG_PREFS_DEFAULTS.vectorDim)
      : MEMORY_PG_PREFS_DEFAULTS.vectorDim,
    vectorEnabled: typeof r.vectorEnabled === 'boolean'
      ? r.vectorEnabled
      : MEMORY_PG_PREFS_DEFAULTS.vectorEnabled,
  }
}
