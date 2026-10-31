import { describe, expect, it, vi } from 'vitest'

// #7199 健康 —— 手机把 Health Connect 的记录算成 health.summary(睡眠归醒来那天、分期合计、基线状态、锻炼中文名);
// 健康这一组的可用性(没有 Health Connect / 咕咕太旧 / 没给 / 给了几类);页面一侧读那份本机 JSON。

vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({}) }))

import { baselineStatus, readHealthSummary, type HealthSummary } from '@gugu/core/shared/healthSummary'
import { buildHealthSummary, buildNights, buildWorkouts, dailyAverage, exerciseName, latestSample } from '../../../../apps/desktop/src/mobile/phone-device/phoneHealth'
import { buildPhoneActionsCapability, missingRequirements, type PhoneGroupGrants, type PhoneOsState } from '../../../../apps/desktop/src/mobile/phone-device/phoneActionCatalog'
import type { NativeHealthDay, NativeHealthStatus, NativeSleepSession } from '../../../../apps/desktop/src/mobile/phone-device/nativePhoneActions'

/** 手机本地时间(测试跑在哪个时区都对:Date 的本地就是这台机器的时区)。 */
const at = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min).getTime()
const MIN = 60_000

function session(start: number, end: number, stages: NativeSleepSession['stages'] = [], source = 'com.ouraring.oura'): NativeSleepSession {
  return { start_ms: start, end_ms: end, source, title: null, stages }
}

describe('睡眠:一晚记在醒来那天', () => {
  it('分期按名字合计,清醒不算睡着', () => {
    const bed = at(2026, 10, 14, 23, 0)
    const [night] = buildNights([
      session(bed, bed + 480 * MIN, [
        { start_ms: bed, end_ms: bed + 20 * MIN, stage: 'awake' },
        { start_ms: bed + 20 * MIN, end_ms: bed + 200 * MIN, stage: 'light' },
        { start_ms: bed + 200 * MIN, end_ms: bed + 290 * MIN, stage: 'deep' },
        { start_ms: bed + 290 * MIN, end_ms: bed + 380 * MIN, stage: 'rem' },
        { start_ms: bed + 380 * MIN, end_ms: bed + 480 * MIN, stage: 'light' },
      ]),
    ])
    expect(night).toMatchObject({ date: '2026-10-15', in_bed_minutes: 480, asleep_minutes: 460, stages: { awake: 20, light: 280, deep: 90, rem: 90, asleep_unstaged: 0 } })
    expect(night!.start.startsWith('2026-10-14T23:00:00')).toBe(true)
  })

  it('没分期的来源整段算睡着,stages = null', () => {
    const bed = at(2026, 10, 15, 0, 30)
    const [night] = buildNights([session(bed, bed + 420 * MIN, [], 'com.heytap.health')])
    expect(night).toMatchObject({ date: '2026-10-15', asleep_minutes: 420, stages: null, sources: ['com.heytap.health'] })
  })

  it('同一天醒来的几段(半夜醒来又睡)合成一晚:上床最早、醒来最晚、睡着相加', () => {
    const nights = buildNights([
      session(at(2026, 10, 15, 1, 0), at(2026, 10, 15, 4, 0)),
      session(at(2026, 10, 14, 23, 0), at(2026, 10, 15, 0, 30)),
      session(at(2026, 10, 13, 23, 0), at(2026, 10, 14, 7, 0)),
    ])
    expect(nights.map((n) => n.date)).toEqual(['2026-10-14', '2026-10-15'])
    expect(nights[1]).toMatchObject({ in_bed_minutes: 300, asleep_minutes: 270 })
  })

  it('两个 App 记了同一晚:只取睡着最多的那个来源,❌ 相加', () => {
    const bed = at(2026, 10, 14, 23, 0)
    const [night] = buildNights([session(bed, bed + 480 * MIN, [], 'watch'), session(bed + 10 * MIN, bed + 470 * MIN, [], 'phone')])
    expect(night).toMatchObject({ asleep_minutes: 480, in_bed_minutes: 480, sources: ['watch'] })
  })

  it('白天的小睡不并进昨晚', () => {
    const nights = buildNights([session(at(2026, 10, 14, 23, 0), at(2026, 10, 15, 7, 0)), session(at(2026, 10, 15, 14, 0), at(2026, 10, 15, 15, 0))])
    expect(nights).toHaveLength(1)
    expect(nights[0]).toMatchObject({ date: '2026-10-15', in_bed_minutes: 480, asleep_minutes: 480 })
  })

  it('过了午夜才睡(中点在凌晨)仍算那一晚', () => {
    const [night] = buildNights([session(at(2026, 10, 15, 2, 0), at(2026, 10, 15, 9, 0))])
    expect(night!.date).toBe('2026-10-15')
  })

  it('起止颠倒的坏记录不算', () => {
    expect(buildNights([session(at(2026, 10, 15, 8), at(2026, 10, 15, 7))])).toEqual([])
  })
})

describe('基线状态(六档)', () => {
  const history = [400, 420, 410, 430, 415]
  it('10% 以内 = 正常', () => {
    expect(baselineStatus('sleep', 440, history)).toEqual({ baseline: 415, status: 'typical' })
  })
  it('好的方向超过 10% = 很棒(睡得多、HRV 高、静息心率低)', () => {
    expect(baselineStatus('sleep', 480, history).status).toBe('optimal')
    expect(baselineStatus('hrv', 60, [45, 48, 50]).status).toBe('optimal')
    expect(baselineStatus('resting_hr', 50, [60, 61, 59]).status).toBe('optimal')
  })
  it('坏的方向 10%–25% = 略高 / 略低,再往外 = 较高 / 较低', () => {
    expect(baselineStatus('sleep', 350, history).status).toBe('below')
    expect(baselineStatus('sleep', 280, history).status).toBe('low')
    expect(baselineStatus('resting_hr', 68, [60, 60, 60]).status).toBe('above')
    expect(baselineStatus('resting_hr', 80, [60, 60, 60]).status).toBe('high')
  })
  it('之前不到 3 天有数据、或这一天没数据 = 不下结论', () => {
    expect(baselineStatus('sleep', 400, [400, null, 410])).toEqual({ baseline: null, status: null })
    expect(baselineStatus('sleep', null, history)).toEqual({ baseline: 415, status: null })
  })
  it('只看之前最近 14 天', () => {
    const old = Array.from({ length: 20 }, () => 100)
    const recent = Array.from({ length: 14 }, () => 400)
    expect(baselineStatus('sleep', 400, [...old, ...recent]).baseline).toBe(400)
  })
})

describe('按时间点记的读数与锻炼', () => {
  it('HRV 按天平均;最近一次取时间最晚的', () => {
    const samples = [
      { time_ms: at(2026, 10, 15, 3), value: 40, source: 'a' },
      { time_ms: at(2026, 10, 15, 5), value: 50, source: 'a' },
      { time_ms: at(2026, 10, 14, 4), value: 30, source: 'a' },
    ]
    expect(Object.fromEntries(dailyAverage(samples))).toEqual({ '2026-10-15': 45, '2026-10-14': 30 })
    expect(latestSample(samples)?.value).toBe(50)
    expect(latestSample([])).toBeNull()
  })

  it('锻炼新的在前、带中文名;认不出的类型叫「锻炼」', () => {
    const workouts = buildWorkouts([
      { start_ms: at(2026, 10, 13, 7), end_ms: at(2026, 10, 13, 7, 45), source: 'x', exercise_type: 33, title: null, active_kcal: 410, distance_m: 6200, hr_avg: 151, hr_max: 176, steps: 7000 },
      { start_ms: at(2026, 10, 14, 19), end_ms: at(2026, 10, 14, 20), source: 'x', exercise_type: 999, title: '晚练' },
    ])
    expect(workouts.map((w) => [w.name, w.minutes])).toEqual([['锻炼', 60], ['跑步', 45]])
    expect(workouts[0]).toMatchObject({ title: '晚练', active_kcal: null, hr_avg: null })
    expect(exerciseName(45)).toBe('力量训练')
  })
})

function day(date: string, overrides: Partial<NativeHealthDay> = {}): NativeHealthDay {
  return { date, steps: null, distance_m: null, active_kcal: null, hr_avg: null, hr_min: null, hr_max: null, resting_hr: null, exercise_ms: null, ...overrides }
}

const STATUS: NativeHealthStatus = { supported: true, granted_types: ['steps', 'sleep', 'resting_heart_rate', 'hrv'], background_supported: true, background_granted: false }

function summary(): HealthSummary {
  const now = at(2026, 10, 15, 9, 0)
  // 21 天:前 14 天是基线,后 7 天交出去。
  const daily = Array.from({ length: 21 }, (_, i) => {
    const d = new Date(2026, 9, 15 - 20 + i)
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    return day(date, { steps: 8000 + i, resting_hr: i === 20 ? null : i === 19 ? 70 : 60 })
  })
  const sleep = Array.from({ length: 21 }, (_, i) => {
    const wake = new Date(2026, 9, 15 - 20 + i, 7, 0).getTime()
    return session(wake - (i === 20 ? 300 : 420) * MIN, wake)
  })
  return buildHealthSummary({ now, days: 7, status: STATUS, daily, sleep, hrv: [], exercise: [], body: {}, unreadable: [{ type: 'hrv', message: 'Health Connect 正在同步数据,稍后再试' }] })
}

describe('health.summary', () => {
  it('交最近 7 天;睡眠记在醒来那天;没给的类在 missing_types', () => {
    const s = summary()
    expect(s.days).toHaveLength(7)
    expect(s.range).toEqual({ start_date: '2026-10-09', end_date: '2026-10-15' })
    expect(s.days.at(-1)).toMatchObject({ date: '2026-10-15', sleep_minutes: 300, steps: 8020 })
    expect(s.missing_types).toEqual(['distance', 'active_calories', 'heart_rate', 'exercise', 'oxygen_saturation', 'respiratory_rate', 'weight', 'body_fat'])
    expect(s.last_night).toMatchObject({ date: '2026-10-15', asleep_minutes: 300 })
    expect(s.background).toEqual({ supported: true, granted: false })
    expect(s.unreadable).toEqual([{ type: 'hrv', message: 'Health Connect 正在同步数据,稍后再试' }])
  })

  it('信号:睡眠看昨晚和之前比;静息心率看最近有数据的那天;步数今天没过完不给状态;没给的类不出信号', () => {
    const signals = Object.fromEntries(summary().signals.map((s) => [s.key, s]))
    expect(Object.keys(signals)).toEqual(['sleep', 'steps', 'resting_hr', 'hrv'])
    expect(signals.sleep).toMatchObject({ date: '2026-10-15', value: 300, baseline: 420, status: 'low' })
    expect(signals.resting_hr).toMatchObject({ date: '2026-10-14', value: 70, baseline: 60, status: 'above' })
    expect(signals.steps).toMatchObject({ date: '2026-10-15', value: 8020, status: null })
    expect(signals.hrv).toMatchObject({ value: null, status: null })
    expect(signals.sleep!.series).toHaveLength(7)
  })

  it('页面读回来与手机算的同一份;形状不对说是哪一格', () => {
    const s = summary()
    expect(readHealthSummary(JSON.parse(JSON.stringify(s)))).toEqual({ ok: true, summary: s })
    expect(readHealthSummary({ ...s, v: 2 })).toEqual({ ok: false, problem: 'v' })
    expect(readHealthSummary({ ...s, days: [{ ...s.days[0], steps: 'many' }] })).toEqual({ ok: false, problem: 'days[0].steps' })
    expect(readHealthSummary({ ...s, signals: [{ ...s.signals[0], status: 'great' }] })).toEqual({ ok: false, problem: 'signals[0].status' })
    expect(readHealthSummary(null)).toEqual({ ok: false, problem: 'root' })
  })
})

const ON: PhoneGroupGrants = { calendar: false, contacts: false, location: false, notifications: false, alarm: false, health: true, sms: false, recordings: false, photos: false }
function os(health: Partial<NativeHealthStatus>): PhoneOsState {
  return {
    runtime: { calendar: 'granted', contacts: 'granted', location: 'granted', coarseLocation: 'granted' },
    special: { notification_listener: true, dnd_access: true, location_enabled: true, background_location: true, alarm_app: true, foreground: true },
    health: { ...STATUS, ...health },
  }
}
const healthActions = (state: PhoneOsState, grants = ON) => buildPhoneActionsCapability(grants, state).actions.filter((a) => a.group === 'health')

describe('健康这一组能不能用', () => {
  it('默认关:没连「健康」= not_granted', () => {
    const actions = healthActions(os({}), { ...ON, health: false })
    expect(actions.map((a) => a.name)).toEqual(['health.summary', 'health.sleep', 'health.workouts', 'health.heart_rate', 'health.body'])
    expect(actions.every((a) => !a.available && a.unavailable_reason === 'not_granted')).toBe(true)
  })
  it('给了一类就能用;一类都没给 = os_permission,并要「去授权」', () => {
    expect(healthActions(os({ granted_types: ['sleep'] })).every((a) => a.available)).toBe(true)
    const none = healthActions(os({ granted_types: [] }))
    expect(none.every((a) => a.unavailable_reason === 'os_permission')).toBe(true)
    expect(none[0]!.unavailable_detail).toContain('健康 → 去授权')
    expect(missingRequirements('health', os({ granted_types: [] }))).toEqual(['health_connect'])
    expect(missingRequirements('health', os({}))).toEqual([])
  })
  it('没有 Health Connect / 咕咕太旧 = unsupported,不是「去授权」补得上的', () => {
    const noHc = healthActions(os({ supported: false, granted_types: [] }))
    expect(noHc[0]).toMatchObject({ available: false, unavailable_reason: 'unsupported' })
    expect(noHc[0]!.unavailable_detail).toContain('安卓 14')
    const old = healthActions(os({ supported: false, granted_types: [], old_app: true }))
    expect(old[0]!.unavailable_detail).toContain('版本太旧')
    expect(missingRequirements('health', os({ supported: false, granted_types: [] }))).toEqual([])
  })
})
