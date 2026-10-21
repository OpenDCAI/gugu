/**
 * #7199 健康 —— 手机 `health.summary` 交出的那一份(线上合同):手机按 Health Connect 里的记录算好,
 * 云电脑上的助理(device_call)与「助理」App 的健康页读的是同一份。
 *
 * 基线状态(很棒 / 正常 / 略高 / 略低 / 较高 / 较低,六档):
 * 咕咕在手机上算 —— 拿这一天和它之前最多 14 天的中位数比。✓ 方向(睡得多、HRV 高、静息心率低)超过 10% 叫「很棒」;
 * ✗ 方向 10%–25% 叫「略高 / 略低」,再往外叫「较高 / 较低」;10% 以内叫「正常」。之前不到 3 天有数据 = 不下结论(null)。
 */

export const HEALTH_SUMMARY_VERSION = 1 as const

export const BASELINE_STATUSES = ['optimal', 'typical', 'above', 'below', 'high', 'low'] as const
export type BaselineStatus = (typeof BASELINE_STATUSES)[number]

export const HEALTH_SIGNAL_KEYS = ['sleep', 'steps', 'resting_hr', 'hrv', 'active_kcal'] as const
export type HealthSignalKey = (typeof HEALTH_SIGNAL_KEYS)[number]

/** 哪个方向算好:up = 越多越好,down = 越低越好。 */
export const SIGNAL_GOOD_DIRECTION: Record<HealthSignalKey, 'up' | 'down'> = {
  sleep: 'up',
  steps: 'up',
  resting_hr: 'down',
  hrv: 'up',
  active_kcal: 'up',
}

export const SIGNAL_UNITS: Record<HealthSignalKey, string> = {
  sleep: 'min',
  steps: 'steps',
  resting_hr: 'bpm',
  hrv: 'ms',
  active_kcal: 'kcal',
}

export interface HealthDay {
  /** 手机本地的日历日 YYYY-MM-DD。睡眠记在醒来那一天(「昨晚」= 今天这一格)。 */
  date: string
  steps: number | null
  distance_m: number | null
  active_kcal: number | null
  resting_hr: number | null
  hr_avg: number | null
  hr_min: number | null
  hr_max: number | null
  hrv_ms: number | null
  exercise_minutes: number | null
  sleep_minutes: number | null
}

export interface SleepStages {
  awake: number
  light: number
  deep: number
  rem: number
  /** 只记了「睡着」、没分期的那部分。 */
  asleep_unstaged: number
}

export interface HealthNight {
  /** 醒来那天。 */
  date: string
  /** 上床 / 醒来(手机本地时间,带偏移的 ISO)。 */
  start: string
  end: string
  in_bed_minutes: number
  asleep_minutes: number
  stages: SleepStages | null
  sources: string[]
}

export interface HealthSignal {
  key: HealthSignalKey
  /** value 是哪一天的(睡眠 = 最近一晚醒来那天;步数 / 活动消耗 = 今天,还没过完)。 */
  date: string | null
  value: number | null
  unit: string
  baseline: number | null
  status: BaselineStatus | null
  /** 最近几天(与 days 同一段)。 */
  series: Array<{ date: string; value: number | null }>
}

export interface HealthWorkout {
  exercise_type: number
  /** 中文名(认不出 = 「锻炼」)。 */
  name: string
  title: string | null
  start: string
  end: string
  minutes: number
  active_kcal: number | null
  distance_m: number | null
  steps: number | null
  hr_avg: number | null
  hr_max: number | null
  source: string
}

export interface HealthLatest {
  value: number
  at: string
}

export interface HealthSummary {
  v: typeof HEALTH_SUMMARY_VERSION
  timezone: string
  generated_at: string
  range: { start_date: string; end_date: string }
  granted_types: string[]
  missing_types: string[]
  background: { supported: boolean; granted: boolean }
  days: HealthDay[]
  last_night: HealthNight | null
  signals: HealthSignal[]
  workouts: HealthWorkout[]
  body: {
    weight_kg: HealthLatest | null
    body_fat_pct: HealthLatest | null
    oxygen_saturation_pct: HealthLatest | null
    respiratory_rate: HealthLatest | null
  }
  /** 给了权限、但这一类这次没读出来(读失败):如实说,❌ 当成没有数据。 */
  unreadable: Array<{ type: string; message: string }>
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export const BASELINE_WINDOW_DAYS = 14
export const BASELINE_MIN_DAYS = 3

/** 这一天的值和它之前那几天(只放之前的,❌ 含这一天)比出来的状态;之前不到 3 天有数据 = null。 */
export function baselineStatus(
  key: HealthSignalKey,
  value: number | null,
  history: ReadonlyArray<number | null>,
): { baseline: number | null; status: BaselineStatus | null } {
  const known = history.filter((v): v is number => typeof v === 'number' && Number.isFinite(v)).slice(-BASELINE_WINDOW_DAYS)
  const baseline = known.length >= BASELINE_MIN_DAYS ? median(known) : null
  if (value === null || baseline === null || baseline === 0) return { baseline, status: null }
  const delta = (value - baseline) / baseline
  if (Math.abs(delta) <= 0.1) return { baseline, status: 'typical' }
  const up = delta > 0
  const good = SIGNAL_GOOD_DIRECTION[key] === 'up' ? up : !up
  if (good) return { baseline, status: 'optimal' }
  const far = Math.abs(delta) > 0.25
  return { baseline, status: up ? (far ? 'high' : 'above') : far ? 'low' : 'below' }
}

// ── 读(页面一侧拿到的是不可信的 JSON:形状不对就说哪一格,❌ 跳过装作没有) ──────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === 'object' && !Array.isArray(v)
class Problem extends Error {}
const numOrNull = (o: Obj, k: string, at: string): number | null => {
  const v = o[k]
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Problem(`${at}.${k}`)
  return v
}
const strField = (o: Obj, k: string, at: string): string => {
  const v = o[k]
  if (typeof v !== 'string') throw new Problem(`${at}.${k}`)
  return v
}
const arr = (o: Obj, k: string, at: string): unknown[] => {
  const v = o[k]
  if (!Array.isArray(v)) throw new Problem(`${at}.${k}`)
  return v
}
const latest = (v: unknown, at: string): HealthLatest | null => {
  if (v === null || v === undefined) return null
  if (!isObj(v) || typeof v.value !== 'number' || typeof v.at !== 'string') throw new Problem(at)
  return { value: v.value, at: v.at }
}

export type HealthSummaryRead = { ok: true; summary: HealthSummary } | { ok: false; problem: string }

export function readHealthSummary(raw: unknown): HealthSummaryRead {
  try {
    if (!isObj(raw)) throw new Problem('root')
    if (raw.v !== HEALTH_SUMMARY_VERSION) throw new Problem('v')
    const range = raw.range
    if (!isObj(range)) throw new Problem('range')
    const background = raw.background
    if (!isObj(background)) throw new Problem('background')
    const body = raw.body
    if (!isObj(body)) throw new Problem('body')
    const strings = (k: string) => arr(raw, k, 'root').map((v, i) => {
      if (typeof v !== 'string') throw new Problem(`${k}[${i}]`)
      return v
    })
    const days = arr(raw, 'days', 'root').map((d, i): HealthDay => {
      const at = `days[${i}]`
      if (!isObj(d)) throw new Problem(at)
      return {
        date: strField(d, 'date', at),
        steps: numOrNull(d, 'steps', at),
        distance_m: numOrNull(d, 'distance_m', at),
        active_kcal: numOrNull(d, 'active_kcal', at),
        resting_hr: numOrNull(d, 'resting_hr', at),
        hr_avg: numOrNull(d, 'hr_avg', at),
        hr_min: numOrNull(d, 'hr_min', at),
        hr_max: numOrNull(d, 'hr_max', at),
        hrv_ms: numOrNull(d, 'hrv_ms', at),
        exercise_minutes: numOrNull(d, 'exercise_minutes', at),
        sleep_minutes: numOrNull(d, 'sleep_minutes', at),
      }
    })
    const signals = arr(raw, 'signals', 'root').map((s, i): HealthSignal => {
      const at = `signals[${i}]`
      if (!isObj(s)) throw new Problem(at)
      const key = s.key
      if (!HEALTH_SIGNAL_KEYS.includes(key as HealthSignalKey)) throw new Problem(`${at}.key`)
      const status = s.status
      if (status !== null && !BASELINE_STATUSES.includes(status as BaselineStatus)) throw new Problem(`${at}.status`)
      return {
        key: key as HealthSignalKey,
        date: s.date === null ? null : strField(s, 'date', at),
        value: numOrNull(s, 'value', at),
        unit: strField(s, 'unit', at),
        baseline: numOrNull(s, 'baseline', at),
        status: status as BaselineStatus | null,
        series: arr(s, 'series', at).map((p, j) => {
          const pAt = `${at}.series[${j}]`
          if (!isObj(p)) throw new Problem(pAt)
          return { date: strField(p, 'date', pAt), value: numOrNull(p, 'value', pAt) }
        }),
      }
    })
    const workouts = arr(raw, 'workouts', 'root').map((w, i): HealthWorkout => {
      const at = `workouts[${i}]`
      if (!isObj(w)) throw new Problem(at)
      return {
        exercise_type: numOrNull(w, 'exercise_type', at) ?? 0,
        name: strField(w, 'name', at),
        title: w.title === null || w.title === undefined ? null : strField(w, 'title', at),
        start: strField(w, 'start', at),
        end: strField(w, 'end', at),
        minutes: numOrNull(w, 'minutes', at) ?? 0,
        active_kcal: numOrNull(w, 'active_kcal', at),
        distance_m: numOrNull(w, 'distance_m', at),
        steps: numOrNull(w, 'steps', at),
        hr_avg: numOrNull(w, 'hr_avg', at),
        hr_max: numOrNull(w, 'hr_max', at),
        source: strField(w, 'source', at),
      }
    })
    let lastNight: HealthNight | null = null
    if (raw.last_night !== null && raw.last_night !== undefined) {
      const n = raw.last_night
      if (!isObj(n)) throw new Problem('last_night')
      let stages: SleepStages | null = null
      if (n.stages !== null && n.stages !== undefined) {
        if (!isObj(n.stages)) throw new Problem('last_night.stages')
        const st = n.stages
        stages = {
          awake: numOrNull(st, 'awake', 'last_night.stages') ?? 0,
          light: numOrNull(st, 'light', 'last_night.stages') ?? 0,
          deep: numOrNull(st, 'deep', 'last_night.stages') ?? 0,
          rem: numOrNull(st, 'rem', 'last_night.stages') ?? 0,
          asleep_unstaged: numOrNull(st, 'asleep_unstaged', 'last_night.stages') ?? 0,
        }
      }
      lastNight = {
        date: strField(n, 'date', 'last_night'),
        start: strField(n, 'start', 'last_night'),
        end: strField(n, 'end', 'last_night'),
        in_bed_minutes: numOrNull(n, 'in_bed_minutes', 'last_night') ?? 0,
        asleep_minutes: numOrNull(n, 'asleep_minutes', 'last_night') ?? 0,
        stages,
        sources: arr(n, 'sources', 'last_night').map(String),
      }
    }
    return {
      ok: true,
      summary: {
        v: HEALTH_SUMMARY_VERSION,
        timezone: strField(raw, 'timezone', 'root'),
        generated_at: strField(raw, 'generated_at', 'root'),
        range: { start_date: strField(range, 'start_date', 'range'), end_date: strField(range, 'end_date', 'range') },
        granted_types: strings('granted_types'),
        missing_types: strings('missing_types'),
        background: { supported: background.supported === true, granted: background.granted === true },
        days,
        last_night: lastNight,
        signals,
        workouts,
        body: {
          weight_kg: latest(body.weight_kg, 'body.weight_kg'),
          body_fat_pct: latest(body.body_fat_pct, 'body.body_fat_pct'),
          oxygen_saturation_pct: latest(body.oxygen_saturation_pct, 'body.oxygen_saturation_pct'),
          respiratory_rate: latest(body.respiratory_rate, 'body.respiratory_rate'),
        },
        unreadable: arr(raw, 'unreadable', 'root').map((u, i) => {
          if (!isObj(u)) throw new Problem(`unreadable[${i}]`)
          return { type: strField(u, 'type', `unreadable[${i}]`), message: strField(u, 'message', `unreadable[${i}]`) }
        }),
      },
    }
  } catch (error) {
    if (error instanceof Problem) return { ok: false, problem: error.message }
    throw error
  }
}
