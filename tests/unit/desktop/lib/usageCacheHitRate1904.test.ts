import { describe, expect, it } from 'vitest'
import type { UsageDay } from '../../../../packages/core/src/shared/usage/dailyUsage'
import { engineRows } from '../../../../apps/desktop/src/lib/usage/derive'
import {
  combinedCacheHitRate,
  inputCacheHitRate,
  isInputCacheTracked,
} from '../../../../apps/desktop/src/lib/usage/cacheHitRate'
import { TOKEN_LOG_READERS } from '../../../../apps/desktop/electron/session/main/core/usage/token-readers/registry'

const range = { from: '2026-11-01', to: '2026-11-06' }
function day(engine: string, values: Partial<UsageDay> = {}): UsageDay {
  return {
    day: '2026-11-06', engine, sessions: 1, runSeconds: 0,
    inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    models: {}, guguModels: {}, byokModels: {}, hours: Array(24).fill(0),
    parallelSeconds: 0, peakConcurrency: 0, ...values,
  }
}

describe('input cache hit rate', () => {
  it('includes cache writes and excludes output from all input', () => {
    expect(inputCacheHitRate(day('claude', {
      inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100, outputTokens: 50_000,
    }))).toBeCloseTo(0.8)
  })

  it('returns no value for a zero denominator, including output-only usage', () => {
    expect(inputCacheHitRate(day('claude'))).toBeNull()
    expect(inputCacheHitRate(day('codex', { outputTokens: 900 }))).toBeNull()
  })

  it('keeps a measured zero distinct from no input', () => {
    expect(inputCacheHitRate(day('claude', { inputTokens: 100 }))).toBe(0)
    expect(inputCacheHitRate(day('codex', { cacheWriteTokens: 100 }))).toBe(0)
  })

  it('returns one for entirely cached input', () => {
    expect(inputCacheHitRate(day('codex', { cacheReadTokens: 800 }))).toBe(1)
  })
})

describe('tracked engines and weighted aggregation', () => {
  it('matches the existing local token readers', () => {
    expect(TOKEN_LOG_READERS.map((reader) => reader.provider).sort()).toEqual(['claude', 'codex'])
    expect(isInputCacheTracked('claude')).toBe(true)
    expect(isInputCacheTracked('codex')).toBe(true)
    for (const engine of ['opencode', 'gemini', '*', '']) expect(isInputCacheTracked(engine)).toBe(false)
  })

  it('sums input buckets before dividing instead of averaging percentages', () => {
    const rows = engineRows([
      day('claude', { inputTokens: 90, cacheReadTokens: 10 }),
      day('codex', { cacheReadTokens: 900 }),
    ], range)
    expect(combinedCacheHitRate(rows)).toBeCloseTo(0.91)
  })

  it('excludes unsupported engines even when they contain nonzero token buckets', () => {
    expect(combinedCacheHitRate([
      day('claude', { inputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 }),
      day('opencode', { inputTokens: 90_000 }),
      day('*', { cacheReadTokens: 90_000 }),
    ])).toBeCloseTo(0.8)
  })

  it('returns no value for no tracked input', () => {
    expect(combinedCacheHitRate([])).toBeNull()
    expect(combinedCacheHitRate([day('codex', { outputTokens: 300 })])).toBeNull()
    expect(combinedCacheHitRate([day('opencode', { cacheReadTokens: 400 })])).toBeNull()
  })

  it('uses the existing date-filtered engine pass for all three buckets', () => {
    const rows = engineRows([
      day('claude', { inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 }),
      day('claude', { day: '2026-11-05', inputTokens: 100, cacheReadTokens: 400, cacheWriteTokens: 50 }),
      day('codex', { day: '2026-10-31', inputTokens: 100_000 }),
      day('*', { cacheReadTokens: 100_000 }),
    ], range)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ inputTokens: 200, cacheReadTokens: 800, cacheWriteTokens: 100 })
    expect(inputCacheHitRate(rows[0])).toBeCloseTo(800 / 1100)
    expect(combinedCacheHitRate(rows)).toBeCloseTo(800 / 1100)
  })
})
