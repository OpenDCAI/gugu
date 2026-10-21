// 用量页(product spec)的全部推导 —— 纯函数,无 React、无取数,单测直接喂数组。
//
// 输入是云端已跨设备合并好的 UsageDay[](会话/运行时长/token,按天×引擎;token 另按来源分咕咕模型 / 自己账号)。
// 积分那一页的推导在 charts.ts。页面上每一个数字都从这里出来,组件只管画。
import { DEVICE_ROW_ENGINE, type UsageDay } from '@gugu/core/shared/usage/dailyUsage'

export type RangePreset = '7d' | '30d' | '90d' | '1y'
export const RANGE_PRESETS: readonly RangePreset[] = ['7d', '30d', '90d', '1y']
const RANGE_DAYS: Record<RangePreset, number> = { '7d': 7, '30d': 30, '90d': 90, '1y': 365 }

/** 热力图固定铺近一年:53 周,和 GitHub 一样;时间段只管上面的数字。 */
export const HEATMAP_DAYS = 371

export type HeatMetric = 'sessions' | 'tokens'

// ── 日期:一律用本地日历日字符串,❌ 不经 toISOString(那是 UTC,会在东八区把凌晨算到前一天) ──

export function localDay(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

export function addDays(day: string, delta: number): string {
  const [y, m, d] = day.split('-').map(Number)
  // 取正午:夏令时切换那天 ±1 小时不会把日子推到隔壁。
  return localDay(new Date(y, m - 1, d + delta, 12))
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, m - 1, d, 12)
}

export type DayRange = { from: string; to: string; days: number }

export function rangeFor(preset: RangePreset, today: string): { current: DayRange; previous: DayRange } {
  const days = RANGE_DAYS[preset]
  const from = addDays(today, -(days - 1))
  return {
    current: { from, to: today, days },
    previous: { from: addDays(from, -days), to: addDays(from, -1), days },
  }
}

const inRange = (day: string, range: { from: string; to: string }) => day >= range.from && day <= range.to

// ── 总览 ──

export type UsageTotals = {
  sessions: number
  tokens: number
  /** tokens 里走咕咕自营模型(扣积分)的那部分。 */
  guguTokens: number
  /** tokens 里走用户自己账号(BYOK:订阅 / 自己的 key)的那部分。tokens − 两者 = 说不清来源的。 */
  byokTokens: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  runSeconds: number
  parallelSeconds: number
  peakConcurrency: number
}

export function sumValues(map: Readonly<Record<string, number>>): number {
  let sum = 0
  for (const value of Object.values(map)) sum += value
  return sum
}

export function tokensOf(row: Pick<UsageDay, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens'>): number {
  return row.inputTokens + row.outputTokens + row.cacheReadTokens + row.cacheWriteTokens
}

export function totalsFor(days: readonly UsageDay[], range: { from: string; to: string }): UsageTotals {
  const totals: UsageTotals = {
    sessions: 0, tokens: 0, guguTokens: 0, byokTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    runSeconds: 0, parallelSeconds: 0, peakConcurrency: 0,
  }
  for (const row of days) {
    if (!inRange(row.day, range)) continue
    if (row.engine === DEVICE_ROW_ENGINE) {
      totals.parallelSeconds += row.parallelSeconds
      totals.peakConcurrency = Math.max(totals.peakConcurrency, row.peakConcurrency)
      continue
    }
    totals.sessions += row.sessions
    totals.runSeconds += row.runSeconds
    totals.inputTokens += row.inputTokens
    totals.outputTokens += row.outputTokens
    totals.cacheReadTokens += row.cacheReadTokens
    totals.cacheWriteTokens += row.cacheWriteTokens
    totals.guguTokens += sumValues(row.guguModels)
    totals.byokTokens += sumValues(row.byokModels)
  }
  totals.tokens = totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens
  return totals
}

/**
 * 与上一段同样长的时间比,变化的百分比。上一段是 0 时没有可比的基数 → null(界面不画箭头),
 * ❌ 不写成 +∞% 或 +100%。上一段不在已取回的数据里(还没取)也是 null。
 */
export function changeRatio(current: number, previous: number | null): number | null {
  if (previous === null || previous <= 0) return null
  return (current - previous) / previous
}

// ── 热力图 ──

export type HeatPoint = { date: string; count: number }

export function heatSeries(metric: HeatMetric, days: readonly UsageDay[]): HeatPoint[] {
  const byDay = new Map<string, number>()
  for (const row of days) {
    if (row.engine === DEVICE_ROW_ENGINE) continue
    const value = metric === 'sessions' ? row.sessions : tokensOf(row)
    if (value > 0) byDay.set(row.day, (byDay.get(row.day) ?? 0) + value)
  }
  return [...byDay].map(([date, count]) => ({ date, count })).sort((a, b) => a.date.localeCompare(b.date))
}

/** 「用过」= 那天开过会话、跑过会话、花过 token 里的任何一样(走咕咕模型花积分的那天必然也有 token)。 */
export function activeDays(days: readonly UsageDay[]): Set<string> {
  const set = new Set<string>()
  for (const row of days) {
    if (row.engine === DEVICE_ROW_ENGINE) continue
    if (row.sessions > 0 || row.runSeconds > 0 || tokensOf(row) > 0) set.add(row.day)
  }
  return set
}

/**
 * 连续天数。「当前连续」数到今天为止;今天还没用不算断 —— 从昨天往回数
 * (一早打开页面看见「连续 0 天」是在惩罚还没开工的人,GitHub 与 Claude Code /stats 都这么算)。
 */
export function streaks(active: ReadonlySet<string>, today: string, lookbackDays = HEATMAP_DAYS): { current: number; longest: number } {
  let longest = 0
  let run = 0
  for (let i = lookbackDays - 1; i >= 0; i -= 1) {
    if (active.has(addDays(today, -i))) { run += 1; longest = Math.max(longest, run) } else run = 0
  }
  let current = 0
  let cursor = active.has(today) ? today : addDays(today, -1)
  while (active.has(cursor)) { current += 1; cursor = addDays(cursor, -1) }
  return { current, longest }
}

export function busiestDay(days: readonly UsageDay[], range: { from: string; to: string }): { day: string; sessions: number } | null {
  const byDay = new Map<string, number>()
  for (const row of days) {
    if (row.engine === DEVICE_ROW_ENGINE || !inRange(row.day, range)) continue
    byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.sessions)
  }
  let best: { day: string; sessions: number } | null = null
  for (const [day, sessions] of byDay) {
    if (sessions > 0 && (!best || sessions > best.sessions)) best = { day, sessions }
  }
  return best
}

// ── 按引擎 / 模型 / 钟点 ──

export type EngineRow = { engine: string; sessions: number; tokens: number; guguTokens: number; byokTokens: number; runSeconds: number; share: number }

export function engineRows(days: readonly UsageDay[], range: { from: string; to: string }): EngineRow[] {
  const byEngine = new Map<string, EngineRow>()
  for (const row of days) {
    if (row.engine === DEVICE_ROW_ENGINE || !inRange(row.day, range)) continue
    const entry = byEngine.get(row.engine) ?? { engine: row.engine, sessions: 0, tokens: 0, guguTokens: 0, byokTokens: 0, runSeconds: 0, share: 0 }
    entry.sessions += row.sessions
    entry.tokens += tokensOf(row)
    entry.guguTokens += sumValues(row.guguModels)
    entry.byokTokens += sumValues(row.byokModels)
    entry.runSeconds += row.runSeconds
    byEngine.set(row.engine, entry)
  }
  const rows = [...byEngine.values()].filter((r) => r.sessions > 0 || r.tokens > 0 || r.runSeconds > 0)
  // 占比按会话数算;这段时间一个会话都没新开(只有之前开的会话还在产出)时退回按 token 算。
  // 同一张色带里只用一种单位 —— ❌ 一行按会话、另一行按 token 混着比。
  const totalSessions = rows.reduce((sum, r) => sum + r.sessions, 0)
  const totalTokens = rows.reduce((sum, r) => sum + r.tokens, 0)
  for (const r of rows) {
    r.share = totalSessions > 0 ? r.sessions / totalSessions : totalTokens > 0 ? r.tokens / totalTokens : 0
  }
  return rows.sort((a, b) => b.sessions - a.sessions || b.tokens - a.tokens || a.engine.localeCompare(b.engine))
}

export function hourHistogram(days: readonly UsageDay[], range: { from: string; to: string }): number[] {
  const hours = Array.from({ length: 24 }, () => 0)
  for (const row of days) {
    if (row.engine === DEVICE_ROW_ENGINE || !inRange(row.day, range)) continue
    row.hours.forEach((count, hour) => { if (hour < 24) hours[hour] += count })
  }
  return hours
}

export function peakHour(hours: readonly number[]): number | null {
  let best = -1
  let bestCount = 0
  hours.forEach((count, hour) => { if (count > bestCount) { best = hour; bestCount = count } })
  return best >= 0 ? best : null
}

// ── 积分:每天(一年档按周)按模型堆叠 ──

export const TOKEN_REFERENCES: Record<'zh' | 'en', readonly { key: string; tokens: number }[]> = {
  zh: [
    { key: 'threeBody', tokens: 900_000 },
    { key: 'redChamber', tokens: 1_000_000 },
    { key: 'journeyWest', tokens: 850_000 },
  ],
  en: [
    { key: 'warAndPeace', tokens: 780_000 },
    { key: 'harryPotter', tokens: 1_450_000 },
    { key: 'lordOfTheRings', tokens: 640_000 },
  ],
}

export function tokenComparison(tokens: number, lang: 'zh' | 'en', today: string): { key: string; times: number } | null {
  const refs = TOKEN_REFERENCES[lang]
  const dayIndex = Number(today.replaceAll('-', '')) % refs.length
  const ref = refs[dayIndex]
  const times = tokens / ref.tokens
  // 连一本都读不完时不说「读了 0.1 遍」—— 那不是情绪价值,是尴尬。
  return times >= 1 ? { key: ref.key, times: Math.round(times) } : null
}
