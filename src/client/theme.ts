/**
 * dsh-memory-pg Client half 主题令牌（DSH 皮肤契约）。
 *
 * 规则（2026-09-15 用户反馈修复）：
 * - 所有颜色必须走 `--dsw-alias-*` 主题令牌，**禁止硬编码十六进制颜色**——
 *   硬编码浅色背景 + 缺 color 会在深色主题下继承浅色文字 → 浅底浅字看不见。
 * - 按钮必须显式声明 `color`（label-primary），不能依赖继承。
 * 由 tests/client-theme.spec.ts 守护。
 */

/** 统一圆角。 */
export const ROUND = 8

/** 主题令牌（DSH 皮肤契约，深浅色主题自适应）。 */
export const TOKEN = {
  labelPrimary: 'var(--dsw-alias-label-primary)',
  labelSecondary: 'var(--dsw-alias-label-secondary)',
  labelTertiary: 'var(--dsw-alias-label-tertiary)',
  border: 'var(--dsw-alias-border-l2)',
  bgLayer1: 'var(--dsw-alias-bg-layer-1)',
  bgLayer2: 'var(--dsw-alias-bg-layer-2)',
  interactiveHover: 'var(--dsw-alias-interactive-bg-hover)',
  success: 'var(--dsw-alias-state-success-primary)',
  error: 'var(--dsw-alias-state-error-primary)',
  warn: 'var(--dsw-alias-state-warn-primary)',
} as const

/** 统一控件/卡片样式（内联，轻量；颜色全走主题令牌）。 */
export const inputStyle = {
  marginLeft: 8,
  padding: '4px 10px',
  borderRadius: ROUND,
  border: `1px solid ${TOKEN.border}`,
  background: TOKEN.bgLayer1,
  color: TOKEN.labelPrimary,
  fontSize: 13,
} as const

export const buttonStyle = {
  padding: '5px 14px',
  borderRadius: ROUND,
  border: `1px solid ${TOKEN.border}`,
  background: TOKEN.bgLayer2,
  color: TOKEN.labelPrimary,
  cursor: 'pointer',
  fontSize: 13,
} as const

export const cardStyle = {
  border: `1px solid ${TOKEN.border}`,
  borderRadius: ROUND,
  padding: '10px 12px',
  marginTop: 12,
} as const

export const rowStyle = {
  display: 'flex',
  gap: 8,
  marginTop: 8,
  flexWrap: 'wrap',
} as const

export const labelStyle = { display: 'block', marginBottom: 8 } as const
