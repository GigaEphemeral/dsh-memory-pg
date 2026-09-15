/**
 * dsh-memory-pg 用户偏好 schemastery schema（host 侧注册用）。
 * 与 prefs.ts 共享类型；schema 是设置面板表单的事实来源。
 */
import z from 'schemastery'
import {
  DB_PORT_MAX,
  DB_PORT_MIN,
  VECTOR_DIM_MAX,
  VECTOR_DIM_MIN,
  type MemoryPgPrefs,
} from './prefs.ts'

export type { MemoryPgPrefs } from './prefs.ts'
export {
  SETTINGS_NS,
  MEMORY_PG_PREFS_DEFAULTS,
  DB_PORT_MIN,
  DB_PORT_MAX,
  VECTOR_DIM_MIN,
  VECTOR_DIM_MAX,
} from './prefs.ts'

/** 用户偏好 schema：每个字段带默认值；secret 字段（dbPassword）wire 读取时 redact。 */
export const PrefsSchema: z<MemoryPgPrefs> = z.object({
  dbHost: z.string().default('localhost'),
  dbPort: z.number().step(1).min(DB_PORT_MIN).max(DB_PORT_MAX).default(54320),
  dbUser: z.string().default('postgres'),
  dbPassword: z.string().default(''),
  dbName: z.string().default('dsh_memory_pg'),
  embeddingBaseUrl: z.string().default('http://localhost:11434/v1/embeddings'),
  embeddingModel: z.string().default('bge-m3'),
  vectorDim: z.number().step(1).min(VECTOR_DIM_MIN).max(VECTOR_DIM_MAX).default(1024),
  vectorEnabled: z.boolean().default(false),
})
