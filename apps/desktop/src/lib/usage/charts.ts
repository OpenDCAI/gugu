// 用量页图表的取数:把「天 × 模型 × 量」摊成 VChart 吃的扁平点列。纯函数,单测覆盖。
import type { CreditUsageDay, UsageDay } from '@gugu/core/shared/usage/dailyUsage'
import { DEVICE_ROW_ENGINE } from '@gugu/core/shared/usage/dailyUsage'
import { addDays, parseDay, type DayRange } from './derive'

export type ModelAmount = { day: string; model: string | null; value: number }
export type ChartPoint = { time: string; model: string; value: number }
export type ModelTotal = { model: string; value: number }

export function creditAmounts(rows: readonly CreditUsageDay[], field: 'credits' | 'requests'): ModelAmount[] {
  return rows.map((row) => ({ day: row.day, model: row.model, value: row[field] }))
}

/** source:null = 全部;'gugu' / 'byok' 只取那一种来源的 token。 */
export function tokenAmounts(days: readonly UsageDay[], source: 'gugu' | 'byok' | null = null): ModelAmount[] {
  const out: ModelAmount[] = []
  for (const row of days) {
    if (row.engine === DEVICE_ROW_ENGINE) continue
    const models = source === 'gugu' ? row.guguModels : source === 'byok' ? row.byokModels : row.models
    for (const [model, tokens] of Object.entries(models)) out.push({ day: row.day, model, value: tokens })
  }
  return out
}

const inRange = (day: string, range: { from: string; to: string }) => day >= range.from && day <= range.to

/** 按模型合计、降序;第 limit 名以后(以及没有模型名的)并成 otherLabel 一项,放在最后。 */
export function rankModels(amounts: readonly ModelAmount[], range: { from: string; to: string }, limit: number, otherLabel: string): ModelTotal[] {
  const byModel = new Map<string, number>()
  let unnamed = 0
  for (const a of amounts) {
    if (!inRange(a.day, range) || a.value <= 0) continue
    if (a.model) byModel.set(a.model, (byModel.get(a.model) ?? 0) + a.value)
    else unnamed += a.value
  }
  const sorted = [...byModel].sort((x, y) => y[1] - x[1]).map(([model, value]) => ({ model, value }))
  const head = sorted.slice(0, limit)
  const rest = sorted.slice(limit).reduce((sum, m) => sum + m.value, 0) + unnamed
  return rest > 0 ? [...head, { model: otherLabel, value: rest }] : head
}

/** 一年档按周成桶(一根柱子一周),其余按天。label 是桶起始日的「MM-DD」。 */
export function buckets(range: DayRange): { start: string; end: string; label: string }[] {
  const step = range.days > 120 ? 7 : 1
  const out: { start: string; end: string; label: string }[] = []
  for (let start = range.from; start <= range.to; start = addDays(start, step)) {
    const end = addDays(start, step - 1) > range.to ? range.to : addDays(start, step - 1)
    const d = parseDay(start)
    out.push({ start, end, label: `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` })
  }
  return out
}

/**
 * 堆叠图的点列:每个桶 × 每个系列都有一点(没有量记 0),空桶也留着柱位 —— 否则 x 轴会把
 * 没用过的日子吞掉,一周只用了两天看起来像连着的两天。domain 是图例顺序(量大的在前,「其他」垫底)。
 */
export function stackedPoints(amounts: readonly ModelAmount[], range: DayRange, limit: number, otherLabel: string): { points: ChartPoint[]; domain: string[]; total: number } {
  const ranked = rankModels(amounts, range, limit, otherLabel)
  const domain = ranked.map((m) => m.model)
  const named = new Set(domain.filter((m) => m !== otherLabel))
  const bs = buckets(range)
  const grid = bs.map(() => new Map<string, number>())
  for (const a of amounts) {
    if (!inRange(a.day, range) || a.value <= 0) continue
    const index = bs.findIndex((b) => a.day >= b.start && a.day <= b.end)
    if (index < 0) continue
    const key = a.model && named.has(a.model) ? a.model : otherLabel
    grid[index].set(key, (grid[index].get(key) ?? 0) + a.value)
  }
  const points: ChartPoint[] = []
  bs.forEach((b, i) => {
    if (domain.length === 0) points.push({ time: b.label, model: otherLabel, value: 0 })
    for (const model of domain) points.push({ time: b.label, model, value: grid[i].get(model) ?? 0 })
  })
  return { points, domain, total: ranked.reduce((sum, m) => sum + m.value, 0) }
}

/** 平均每分钟:区间内的总量 ÷ 区间分钟数(今天只算到此刻)。统计条的 RPM/TPM 口径。 */
export function perMinute(total: number, range: { from: string; to: string }, now: Date): number {
  // parseDay 落在正午(防夏令时),这里要的是当天零点。
  const midnight = (day: string) => { const d = parseDay(day); d.setHours(0, 0, 0, 0); return d.getTime() }
  const start = midnight(range.from)
  const endOfRange = midnight(addDays(range.to, 1))
  const minutes = (Math.min(endOfRange, now.getTime()) - start) / 60_000
  return minutes > 0 ? total / minutes : 0
}
