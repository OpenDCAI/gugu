// 本机汇总 → 云端 public.usage_daily 的行。纯映射,不碰网络(单测直接喂)。
import { DEVICE_ROW_ENGINE, type LocalUsageSnapshot } from '@gugu/core/shared/usage/dailyUsage'

export type UsageDailyRow = {
  user_id: string
  device_id: string
  day: string
  engine: string
  sessions: number
  run_seconds: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  models: Record<string, number>
  gugu_models: Record<string, number>
  byok_models: Record<string, number>
  hours: number[]
  parallel_seconds: number
  peak_concurrency: number
}

export function snapshotToRows(snapshot: LocalUsageSnapshot, userId: string, deviceId: string): UsageDailyRow[] {
  const base = { user_id: userId, device_id: deviceId }
  const rows: UsageDailyRow[] = snapshot.engines.map((e) => ({
    ...base,
    day: e.day,
    engine: e.engine,
    sessions: Math.round(e.sessions),
    run_seconds: Math.round(e.runSeconds),
    input_tokens: Math.round(e.inputTokens),
    output_tokens: Math.round(e.outputTokens),
    cache_read_tokens: Math.round(e.cacheReadTokens),
    cache_write_tokens: Math.round(e.cacheWriteTokens),
    models: e.models,
    gugu_models: e.guguModels,
    byok_models: e.byokModels,
    hours: Array.from({ length: 24 }, (_, i) => Math.round(e.hours[i] ?? 0)),
    parallel_seconds: 0,
    peak_concurrency: 0,
  }))
  for (const d of snapshot.device) {
    rows.push({
      ...base,
      day: d.day,
      engine: DEVICE_ROW_ENGINE,
      sessions: 0, run_seconds: 0, input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0,
      models: {}, gugu_models: {}, byok_models: {},
      hours: Array.from({ length: 24 }, () => 0),
      parallel_seconds: Math.round(d.parallelSeconds),
      peak_concurrency: Math.round(d.peakConcurrency),
    })
  }
  return rows
}
