import type { UsageDay } from '@gugu/core/shared/usage/dailyUsage'

export type InputTokenBuckets = Pick<UsageDay, 'inputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>

/** A1 covers the existing Claude and Codex local log readers. */
export function isInputCacheTracked(engine: string): boolean {
  return engine === 'claude' || engine === 'codex'
}

/** Input buckets are disjoint; output tokens never belong in this denominator. */
export function inputCacheHitRate(tokens: InputTokenBuckets): number | null {
  const input = tokens.inputTokens + tokens.cacheReadTokens + tokens.cacheWriteTokens
  return input > 0 ? tokens.cacheReadTokens / input : null
}

/** Consume already aggregated engine rows, without revisiting daily rows or logs. */
export function combinedCacheHitRate(rows: readonly (InputTokenBuckets & { engine: string })[]): number | null {
  const tokens: InputTokenBuckets = { inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  for (const row of rows) {
    if (!isInputCacheTracked(row.engine)) continue
    tokens.inputTokens += row.inputTokens
    tokens.cacheReadTokens += row.cacheReadTokens
    tokens.cacheWriteTokens += row.cacheWriteTokens
  }
  return inputCacheHitRate(tokens)
}
