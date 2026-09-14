import { describe, expect, it } from 'vitest'
import { parsePrefs, MEMORY_PG_PREFS_DEFAULTS } from '../src/prefs.ts'

describe('parsePrefs', () => {
  it('returns defaults for null / non-object input', () => {
    expect(parsePrefs(null)).toEqual(MEMORY_PG_PREFS_DEFAULTS)
    expect(parsePrefs('nope')).toEqual(MEMORY_PG_PREFS_DEFAULTS)
  })

  it('validates each field with per-field fallback', () => {
    const p = parsePrefs({ dbHost: 123, dbPort: 'bad', dbName: 'test', vectorDim: 'x' })
    expect(p.dbHost).toBe(MEMORY_PG_PREFS_DEFAULTS.dbHost)
    expect(p.dbPort).toBe(MEMORY_PG_PREFS_DEFAULTS.dbPort)
    expect(p.dbName).toBe('test')
    expect(p.vectorDim).toBe(MEMORY_PG_PREFS_DEFAULTS.vectorDim)
  })

  it('clamps port and vectorDim into range (not fallback default)', () => {
    expect(parsePrefs({ dbPort: 0 }).dbPort).toBe(1)            // min bound
    expect(parsePrefs({ dbPort: 70000 }).dbPort).toBe(65535)    // max bound
    expect(parsePrefs({ vectorDim: 0 }).vectorDim).toBe(1)
    expect(parsePrefs({ vectorDim: 999999 }).vectorDim).toBe(65535)
  })
})
