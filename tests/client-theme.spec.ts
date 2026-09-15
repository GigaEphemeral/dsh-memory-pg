import { describe, expect, it } from 'vitest'
import { TOKEN, buttonStyle, inputStyle, cardStyle, ROUND } from '../src/client/theme.ts'

/**
 * Client 主题契约守护（2026-09-15 用户反馈：深色背景下按钮文字不可见）。
 * 规则：
 * 1. 所有颜色必须是 `--dsw-alias-*` 主题令牌，禁止硬编码十六进制。
 * 2. 按钮必须显式声明 color（不能依赖继承——深色主题下会继承浅色文字，
 *    浅底浅字不可见）。
 * 3. 控件背景/边框必须来自主题层令牌（不能是固定浅色）。
 */

const HEX = /#[0-9a-f]{3,8}\b/i

describe('theme tokens', () => {
  it('all tokens are --dsw-alias-* CSS variables', () => {
    for (const [name, value] of Object.entries(TOKEN)) {
      expect(value, `token ${name}`).toMatch(/^var\(--dsw-alias-[\w-]+\)$/)
      expect(value, `token ${name}`).not.toMatch(HEX)
    }
  })

  it('no hardcoded hex colors anywhere in theme module', () => {
    // 颜色类字段（color/background/border）必须是 var(--dsw-alias-*) 开头，禁止 hex。
    const styleObjects = [buttonStyle, inputStyle, cardStyle]
    for (const style of styleObjects) {
      for (const [key, value] of Object.entries(style)) {
        if (typeof value !== 'string') continue
        // border 形如 '1px solid var(--dsw-alias-...)'；color/background 是纯 var()
        const isColorField = key === 'color' || key === 'background'
        if (isColorField) {
          expect(value, `${key} of ${style === buttonStyle ? 'button' : 'control'}`).toMatch(/^var\(--dsw-alias-[\w-]+\)$/)
        } else if (key === 'border') {
          expect(value, 'border').toMatch(/^1px solid var\(--dsw-alias-[\w-]+\)$/)
        }
        expect(value, `${key} hex`).not.toMatch(HEX)
      }
    }
  })

  it('button style declares explicit color (regression: invisible text on dark theme)', () => {
    expect(buttonStyle.color).toBeDefined()
    expect(buttonStyle.color).toMatch(/^var\(--dsw-alias-[\w-]+\)$/)
    // 背景不能是固定浅色（深色主题下浅底浅字）
    expect(buttonStyle.background).toMatch(/^var\(--dsw-alias-[\w-]+\)$/)
  })

  it('button foreground differs from background token (contrast via theme, not same token)', () => {
    // 文字用 label-primary（前景），背景用 bg-layer-2（表面）——两者是不同令牌，
    // 由主题保证对比度；若同一个令牌说明是笔误。
    expect(buttonStyle.color).not.toBe(buttonStyle.background)
  })

  it('shared radius constant is used by controls', () => {
    expect(buttonStyle.borderRadius).toBe(ROUND)
    expect(inputStyle.borderRadius).toBe(ROUND)
  })
})
