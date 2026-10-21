// #6334 用量页的推导(product spec)。页面上每个数字都从这些纯函数出来,所以口径在这里钉死。
import { describe, expect, it } from 'vitest'
import type { LocalUsageSnapshot, UsageDay } from '../../../../packages/core/src/shared/usage/dailyUsage'
import {
  activeDays,
  addDays,
  busiestDay,
  changeRatio,
  engineRows,
  heatSeries,
  hourHistogram,
  localDay,
  peakHour,
  rangeFor,
  streaks,
  tokenComparison,
  totalsFor,
} from '../../../../apps/desktop/src/lib/usage/derive'
import { rankModels, tokenAmounts } from '../../../../apps/desktop/src/lib/usage/charts'
import { snapshotToRows } from '../../../../apps/desktop/src/lib/usage/rows'

function day(d: string, engine: string, over: Partial<UsageDay> = {}): UsageDay {
  return {
    day: d, engine, sessions: 0, runSeconds: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    models: {}, guguModels: {}, byokModels: {}, hours: Array.from({ length: 24 }, () => 0), parallelSeconds: 0, peakConcurrency: 0, ...over,
  }
}

describe('日期一律是本地日历日', () => {
  it('localDay 不经 UTC:东八区凌晨 1 点仍是当天', () => {
    expect(localDay(new Date(2026, 8, 23, 1, 0))).toBe('2026-09-23')
  })
  it('addDays 跨月跨年', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28')
    expect(addDays('2025-12-31', 1)).toBe('2026-01-01')
  })
  it('时间段:30 天含今天,对照段紧挨在前、同样长', () => {
    const { current, previous } = rangeFor('30d', '2026-09-23')
    expect(current).toEqual({ from: '2026-08-25', to: '2026-09-23', days: 30 })
    expect(previous).toEqual({ from: '2026-07-26', to: '2026-08-24', days: 30 })
  })
})

describe('总览', () => {
  const rows = [
    day('2026-09-20', 'claude', { sessions: 3, runSeconds: 600, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 1 }),
    day('2026-09-21', 'codex', { sessions: 2, runSeconds: 300 }),
    day('2026-09-21', '*', { parallelSeconds: 120, peakConcurrency: 4 }),
    day('2026-09-22', '*', { parallelSeconds: 60, peakConcurrency: 7 }),
    day('2026-08-01', 'claude', { sessions: 99 }),
  ]
  it('只数范围内;整台设备那一行只贡献并行与峰值,❌ 不进会话数', () => {
    const t = totalsFor(rows, { from: '2026-09-20', to: '2026-09-23' })
    expect(t.sessions).toBe(5)
    expect(t.runSeconds).toBe(900)
    expect(t.tokens).toBe(116)
    expect(t.parallelSeconds).toBe(180)
    expect(t.peakConcurrency).toBe(7)
  })
  it('上一段为 0 或还没取到 → 没有百分比,❌ 不写 +100% 或 ∞', () => {
    expect(changeRatio(5, 0)).toBeNull()
    expect(changeRatio(5, null)).toBeNull()
    expect(changeRatio(15, 10)).toBeCloseTo(0.5)
    expect(changeRatio(5, 10)).toBeCloseTo(-0.5)
  })
})

describe('热力图与连续天数', () => {
  it('会话 / token 两种量,各自按天求和,0 的天不出现', () => {
    const rows = [day('2026-09-20', 'claude', { sessions: 1, inputTokens: 7 }), day('2026-09-20', 'codex', { sessions: 2 }), day('2026-09-21', '*', { peakConcurrency: 3 })]
    expect(heatSeries('sessions', rows)).toEqual([{ date: '2026-09-20', count: 3 }])
    expect(heatSeries('tokens', rows)).toEqual([{ date: '2026-09-20', count: 7 }])
  })
  it('开过会话、跑过、花过 token 任一样就算「用过」;整台设备那一行不算', () => {
    const active = activeDays([
      day('2026-09-10', 'claude', { runSeconds: 5 }),
      day('2026-09-11', 'codex', { outputTokens: 1 }),
      day('2026-09-12', '*', { parallelSeconds: 9, peakConcurrency: 2 }),
      day('2026-09-13', 'claude', {}),
    ])
    expect([...active].sort()).toEqual(['2026-09-10', '2026-09-11'])
  })
  it('今天还没用不算断:从昨天往回数', () => {
    const active = new Set(['2026-09-20', '2026-09-21', '2026-09-22'])
    expect(streaks(active, '2026-09-23')).toEqual({ current: 3, longest: 3 })
  })
  it('昨天也没用 → 当前连续为 0,最长照记', () => {
    const active = new Set(['2026-09-01', '2026-09-02', '2026-09-20'])
    expect(streaks(active, '2026-09-23')).toEqual({ current: 0, longest: 2 })
  })
  it('最忙的一天按会话数,没有会话就没有「最忙」', () => {
    expect(busiestDay([day('2026-09-20', 'claude', { sessions: 2 }), day('2026-09-21', 'claude', { sessions: 5 })], { from: '2026-09-01', to: '2026-09-30' }))
      .toEqual({ day: '2026-09-21', sessions: 5 })
    expect(busiestDay([day('2026-09-20', 'claude', { runSeconds: 9 })], { from: '2026-09-01', to: '2026-09-30' })).toBeNull()
  })
})

describe('按引擎 / 模型 / 钟点', () => {
  const range = { from: '2026-09-01', to: '2026-09-30' }
  const hours = (at: number, n: number) => Array.from({ length: 24 }, (_, h) => (h === at ? n : 0))
  const rows = [
    day('2026-09-20', 'codex', { sessions: 1, inputTokens: 500, models: { 'gpt-5.5': 500 }, hours: hours(4, 1) }),
    day('2026-09-20', 'claude', { sessions: 3, inputTokens: 100, models: { 'claude-opus-5': 80, 'claude-sonnet-5': 20 }, hours: hours(4, 2) }),
    day('2026-09-21', 'claude', { sessions: 1, models: { 'claude-opus-5': 10 }, hours: hours(22, 1) }),
    day('2026-09-21', 'opencode', {}),
  ]
  it('引擎按会话数排,占比按会话数算;什么都没干的引擎不出现', () => {
    const r = engineRows(rows, range)
    expect(r.map((x) => x.engine)).toEqual(['claude', 'codex'])
    expect(r[0].share).toBeCloseTo(0.8)
    expect(r[0].tokens).toBe(100)
  })
  it('这段时间一个新会话都没有时,占比退回按 token 算 —— 同一条色带只用一种单位', () => {
    const r = engineRows([day('2026-09-20', 'claude', { inputTokens: 300 }), day('2026-09-20', 'codex', { inputTokens: 100 })], range)
    expect(r.map((x) => x.share)).toEqual([0.75, 0.25])
  })
  it('模型按 token 合并排序(整台设备那一行不算)', () => {
    expect(rankModels(tokenAmounts(rows), range, 10, '其他')).toEqual([
      { model: 'gpt-5.5', value: 500 }, { model: 'claude-opus-5', value: 90 }, { model: 'claude-sonnet-5', value: 20 },
    ])
  })
  it('钟点按位相加,峰值取最多的那个钟点;全空时没有峰值', () => {
    const h = hourHistogram(rows, range)
    expect(h[4]).toBe(3)
    expect(h[22]).toBe(1)
    expect(peakHour(h)).toBe(4)
    expect(peakHour(Array.from({ length: 24 }, () => 0))).toBeNull()
  })
})

describe('那句类比', () => {
  it('连一本都读不完就不说', () => {
    expect(tokenComparison(10, 'zh', '2026-09-23')).toBeNull()
  })
  it('同一天结果不变,取整', () => {
    const a = tokenComparison(13_300_000_000, 'zh', '2026-09-23')
    expect(a).toEqual(tokenComparison(13_300_000_000, 'zh', '2026-09-23'))
    expect(Number.isInteger(a!.times)).toBe(true)
  })
})

describe('本机汇总 → 云端行', () => {
  it('每个引擎一行,并行与峰值单独落在「整台设备」那一行;小数取整、钟点补满 24 位', () => {
    const snapshot: LocalUsageSnapshot = {
      from: '2026-09-23', to: '2026-09-23',
      engines: [{ day: '2026-09-23', engine: 'claude', sessions: 2, runSeconds: 10.6, inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4, models: { m: 10 }, guguModels: { m: 6 }, byokModels: { m: 3 }, hours: [1] }],
      device: [{ day: '2026-09-23', parallelSeconds: 5.4, peakConcurrency: 2 }],
    }
    const rows = snapshotToRows(snapshot, 'u1', 'dev1')
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ user_id: 'u1', device_id: 'dev1', engine: 'claude', run_seconds: 11, parallel_seconds: 0 })
    expect(rows[0].hours).toHaveLength(24)
    expect(rows[0]).toMatchObject({ gugu_models: { m: 6 }, byok_models: { m: 3 } })
    expect(rows[1]).toMatchObject({ engine: '*', sessions: 0, parallel_seconds: 5, peak_concurrency: 2 })
  })
})
