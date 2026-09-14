/**
 * dsh-memory-pg 提炼层：上下文 → 结构化事实（三要素原子单元）。
 *
 * M3 落地 README §16.2（提炼 prompt 纪律 / 长上下文分块 / JSON 容错解析三级）。
 * 设计：distill 是**纯函数 + 可注入 LLM caller**——caller 由调用方注入（真实走 ctx.llm，
 * 测试注入 mock），使解析/分块/容错逻辑可独立单测。
 */

/** 一条提炼产出的事实（三要素 + 标签 + 合成 content）。 */
export interface DistilledFact {
  subject: string
  predicate: string
  object: string
  content: string
  tags: string[]
  importance: number | null
  confidence: number | null
}

/** LLM 消息（prefix-cache 复用：replay 会话前缀 + 指令尾）。 */
export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** LLM 调用结果（含 finish 分类，供截断检测）。 */
export interface LlmCallResult {
  text: string
  /** 完成原因：stop 正常 / max-tokens 截断（调用方应 fail-closed 拒绝残稿） */
  finish: 'stop' | 'max-tokens' | 'error' | 'aborted'
  error?: string
}

/** LLM 调用方：输入完整 messages（已含 replay 前缀 + 指令尾），返回原始文本 + finish。 */
export type LlmCaller = (messages: LlmMessage[]) => Promise<LlmCallResult>

/** 提炼配置（阈值参数，纯逻辑可测）。 */
export interface DistillConfig {
  /** 长上下文分块：单块最大字符数 */
  chunkChars: number
  /** 长上下文分块：最大块数 */
  maxChunks: number
  /** 提炼返回的最大事实条数 */
  maxFacts: number
}

export const DISTILL_DEFAULTS: DistillConfig = {
  chunkChars: 1000,
  maxChunks: 6,
  maxFacts: 8,
}

/** 提炼系统 prompt（§16.2 纪律）：只提取跨会话价值内容，只输出 JSON。 */
export const DISTILL_SYSTEM_PROMPT = [
  '你是长期记忆提炼器。从对话中只提取跨会话仍有价值的事实、用户偏好、约定、决定、环境约束。',
  '不要提取寒暄、过程细节、工具输出、临时文件路径。每条记忆必须是独立完整的中文陈述。',
  '只输出一个 JSON 对象，格式：',
  '{"facts":[{"subject":"...","predicate":"...","object":"...","content":"完整陈述","tags":["标签"]}]}',
  'content 是 subject+predicate+object 的完整句子；不要 Markdown、不要解释。',
  '没有值得记的内容就输出 {"facts":[]}。',
].join(' ')

/**
 * 长上下文分块：按段落打包到 chunkChars，超长段落硬切，最多 maxChunks 块。
 * （§16.2，参考 splitTranscript；纯函数）
 */
export function splitContext(text: string, config: DistillConfig = DISTILL_DEFAULTS): string[] {
  const raw = String(text ?? '')
  const limit = Math.max(200, Number(config.chunkChars) || 1000)
  const chunks: string[] = []
  const paragraphs = raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean)
  let current = ''
  for (const paragraph of paragraphs) {
    if (paragraph.length > limit) {
      if (current) { chunks.push(current.trim()); current = '' }
      for (let i = 0; i < paragraph.length; i += limit) {
        chunks.push(paragraph.slice(i, i + limit).trim())
      }
      continue
    }
    if (current && current.length + paragraph.length + 1 > limit) {
      chunks.push(current.trim())
      current = paragraph
    } else {
      current = current ? `${current}\n${paragraph}` : paragraph
    }
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.slice(0, Math.max(1, Number(config.maxChunks) || chunks.length))
}

/** 提炼输入：可选的会话前缀（replay 到 messages 前面以复用 provider KV cache）+ 待提炼上下文。 */
export interface DistillInput {
  /** 待提炼的上下文文本（分块后放进指令 user 消息）。 */
  context: string
  /** 可选：会话前缀（最近消息），replay 到 messages 开头 → 前缀缓存复用（官方 compaction 同款）。 */
  replayPrefix?: Array<Pick<LlmMessage, 'role' | 'content'>>
  /** 保留尾部条数：context 前段参与提炼，尾部 N 条原样保留（不提炼）——由调用方传入已切好的 context。 */
}

/**
 * 提炼：上下文 → 事实列表。
 * 分块后逐块调用 caller（messages = replayPrefix + 指令 user），合并 + 去重 + 截断 maxFacts。
 * 每块指令作为最后一条 user 消息 → 前缀缓存复用；finish=max-tokens → 抛错拒绝残稿。
 */
export async function distill(
  input: DistillInput,
  caller: LlmCaller,
  config: DistillConfig = DISTILL_DEFAULTS,
): Promise<DistilledFact[]> {
  const chunks = splitContext(input.context, config)
  if (chunks.length === 0) return []
  const out: DistilledFact[] = []
  const seen = new Set<string>()
  const prefix: LlmMessage[] = (input.replayPrefix ?? []).map(m => ({ role: m.role, content: m.content }))
  for (let i = 0; i < chunks.length; i += 1) {
    const instruction = [
      `以下是本次会话的第 ${i + 1}/${chunks.length} 段记录（只提取长期记忆）：`,
      '',
      chunks[i],
      '',
      '提取记忆：',
    ].join('\n')
    // 前缀 + 指令尾：让 provider 复用上轮请求的 KV cache（官方 compaction 的缓存复用设计）。
    const messages: LlmMessage[] = [...prefix, { role: 'user', content: instruction }]
    const result = await caller(messages)
    if (result.finish === 'max-tokens') {
      throw new Error('distill truncated at token cap (incomplete facts rejected)')
    }
    if (result.finish === 'error' || result.finish === 'aborted') {
      throw new Error(`distill failed: ${result.error ?? result.finish}`)
    }
    for (const fact of parseDistilledFacts(result.text)) {
      const key = normKey(`${fact.subject} ${fact.predicate} ${fact.object} ${fact.content}`)
      if (key.length < 4 || seen.has(key)) continue
      seen.add(key)
      out.push(fact)
      if (out.length >= config.maxFacts) return out
    }
  }
  return out
}

/** 归一化去重键（去空白/标点/小写）。 */
export function normKey(text: string): string {
  return String(text || '').toLowerCase().replace(/[\s\u3000\p{P}\p{S}]+/gu, '')
}

/**
 * JSON 容错解析三级：整段 JSON → 剥代码块 → 提取第一个平衡大括号对象（§16.2）。
 */
export function parseDistilledFacts(content: string): DistilledFact[] {
  const text = String(content || '')
  if (!text.trim()) return []
  let json: unknown = null
  try {
    json = JSON.parse(text.trim())
  } catch {
    // fallthrough
  }
  if (json === null) {
    const unboxed = text.replace(/```(?:json)?\s*([\s\S]*?)```/gi, '$1').trim()
    try {
      json = JSON.parse(unboxed)
    } catch {
      // fallthrough
    }
  }
  if (json === null) json = extractBalancedObject(text)
  const raw = (json as { facts?: unknown })?.facts
  const items = Array.isArray(raw) ? raw : Array.isArray(json) ? json : []
  const out: DistilledFact[] = []
  for (const item of items) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const subject = String(o.subject ?? '').trim()
    const predicate = String(o.predicate ?? '').trim()
    const object = String(o.object ?? '').trim()
    const content = String(o.content ?? o.text ?? '').trim()
    if (!subject && !predicate && !object && !content) continue
    if (content.length < 4 && !(subject && predicate && object)) continue
    out.push({
      subject: subject || (content.length > 0 ? content : ''),
      predicate: predicate || '是',
      object: object || '',
      content: content || `${subject} ${predicate} ${object}`.trim(),
      tags: Array.isArray(o.tags)
        ? o.tags.map(t => String(t ?? '').trim()).filter(Boolean).slice(0, 20)
        : [],
      importance: typeof o.importance === 'number' && Number.isFinite(o.importance) ? o.importance : null,
      confidence: typeof o.confidence === 'number' && Number.isFinite(o.confidence) ? o.confidence : null,
    })
  }
  return out.slice(0, 20)
}

/** 提取第一个平衡大括号对象（容错第三级）。 */
function extractBalancedObject(text: string): unknown {
  const start = text.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i]
    if (inString) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') inString = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(text.slice(start, i + 1))
        } catch {
          return null
        }
      }
    }
  }
  return null
}
