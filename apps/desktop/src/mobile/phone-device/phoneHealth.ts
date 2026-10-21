/**
 * #7199 健康 —— 手机上「健康」这一组的几个动作真去读什么、怎么算(原生只把 Health Connect 的记录原样交上来)。
 * 按天合计在原生(系统去重:手表和手机都记了步数不会算两遍);睡眠是原始记录、系统不去重 ——
 * 归到醒来那天、只取一个来源、分期合计,与基线比较、锻炼的中文名都在这里。
 * build* 是纯函数(单测在 tests/unit/desktop/mobile/phoneHealth7199.test.ts);read* 调原生。
 */
import {
  HEALTH_SUMMARY_VERSION,
  SIGNAL_UNITS,
  baselineStatus,
  type HealthDay,
  type HealthLatest,
  type HealthNight,
  type HealthSignal,
  type HealthSignalKey,
  type HealthSummary,
  type HealthWorkout,
  type SleepStages,
} from '@gugu/core/shared/healthSummary'
import {
  HEALTH_TYPES,
  nativeFailure,
  nativePhoneActions,
  type HealthSampleType,
  type HealthType,
  type NativeExerciseSession,
  type NativeHealthDay,
  type NativeHealthSample,
  type NativeHealthStatus,
  type NativeSleepSession,
} from './nativePhoneActions'
import { localDate, localDayStartMs, localIso } from './phoneTime'

const DAY_MS = 24 * 3600_000
const minutes = (ms: number) => Math.round(ms / 60_000)

/** 锻炼类型(ExerciseSessionType 的整数)→ 中文名。认不出的叫「锻炼」。 */
const EXERCISE_NAMES: Record<number, string> = {
  1: '羽毛球', 2: '棒球', 3: '篮球', 4: '骑行', 5: '室内骑行', 6: '训练营', 7: '拳击', 8: '徒手训练', 9: '板球', 10: '跳舞',
  11: '团体课', 12: '击剑', 13: '美式橄榄球', 14: '澳式橄榄球', 15: '飞盘', 16: '高尔夫', 17: '呼吸训练', 18: '体操', 19: '手球',
  20: '高强度间歇训练', 21: '徒步', 22: '冰球', 23: '滑冰', 24: '武术', 25: '划桨', 26: '滑翔伞', 27: '普拉提', 28: '壁球',
  29: '攀岩', 30: '轮滑球', 31: '划船', 32: '橄榄球', 33: '跑步', 34: '跑步机', 35: '帆船', 36: '潜水', 37: '轮滑', 38: '滑雪',
  39: '单板滑雪', 40: '雪鞋行走', 41: '足球', 42: '垒球', 43: '壁球', 44: '爬楼梯', 45: '力量训练', 46: '拉伸', 47: '冲浪',
  48: '公开水域游泳', 49: '泳池游泳', 50: '乒乓球', 51: '网球', 52: '排球', 53: '步行', 54: '水球', 55: '举重', 56: '轮椅',
  57: '瑜伽', 58: '其他锻炼', 59: '爬楼机', 60: '椭圆机', 61: '划船机',
}

export function exerciseName(type: number): string {
  return EXERCISE_NAMES[type] ?? '锻炼'
}

// ── 睡眠 ─────────────────────────────────────────────────────────────────────

const ASLEEP = new Set(['sleeping', 'light', 'deep', 'rem'])

/** 一晚(醒来那天)里的几段睡眠合在一起:上床取最早、醒来取最晚;分期按名字合计(分钟)。 */
function nightOf(date: string, sessions: NativeSleepSession[]): HealthNight {
  const start = Math.min(...sessions.map((s) => s.start_ms))
  const end = Math.max(...sessions.map((s) => s.end_ms))
  let staged = false
  const totals = { awake: 0, light: 0, deep: 0, rem: 0, asleep_unstaged: 0 }
  let asleepMs = 0
  for (const session of sessions) {
    if (session.stages.length === 0) {
      // 只有一段「睡了」没分期:整段算睡着(Health Connect 里不少来源就这么记)。
      asleepMs += session.end_ms - session.start_ms
      totals.asleep_unstaged += session.end_ms - session.start_ms
      continue
    }
    staged = true
    for (const stage of session.stages) {
      const ms = Math.max(0, stage.end_ms - stage.start_ms)
      if (ASLEEP.has(stage.stage)) asleepMs += ms
      if (stage.stage === 'light' || stage.stage === 'deep' || stage.stage === 'rem') totals[stage.stage] += ms
      else if (stage.stage === 'sleeping') totals.asleep_unstaged += ms
      else if (stage.stage === 'awake' || stage.stage === 'awake_in_bed') totals.awake += ms
    }
  }
  const stages: SleepStages | null = staged
    ? { awake: minutes(totals.awake), light: minutes(totals.light), deep: minutes(totals.deep), rem: minutes(totals.rem), asleep_unstaged: minutes(totals.asleep_unstaged) }
    : null
  return {
    date,
    start: localIso(start),
    end: localIso(end),
    in_bed_minutes: minutes(end - start),
    asleep_minutes: minutes(asleepMs),
    stages,
    sources: [...new Set(sessions.map((s) => s.source))],
  }
}

/**
 * 这一段是哪一晚的(醒来那天);白天的小睡(中点不在前一天 18 点到当天中午之间)= null,不算进「一晚」。
 * ❌ 按醒来那天直接归:下午 2 点的午睡会和昨晚合成一段「卧床 16 小时」。
 */
function nightDateOf(session: NativeSleepSession): string | null {
  const mid = new Date((session.start_ms + session.end_ms) / 2)
  const hour = mid.getHours()
  if (hour >= 18) return localDate(localDayStartMs(mid.getTime(), 1))
  return hour < 12 ? localDate(mid.getTime()) : null
}

const asleepMsOf = (session: NativeSleepSession) =>
  session.stages.length === 0
    ? session.end_ms - session.start_ms
    : session.stages.filter((s) => ASLEEP.has(s.stage)).reduce((sum, s) => sum + Math.max(0, s.end_ms - s.start_ms), 0)

/**
 * 按醒来那天分晚(新的在后)。同一晚几个 App 都记了(手表的 App 和手机的 App):只取睡着最多的那一个来源,
 * ❌ 相加 —— 读的是原始记录,系统不替我们去重,相加会出「卧床 8 小时、睡着 16 小时」。
 */
export function buildNights(sessions: readonly NativeSleepSession[]): HealthNight[] {
  const byDate = new Map<string, NativeSleepSession[]>()
  for (const session of [...sessions].sort((a, b) => a.end_ms - b.end_ms)) {
    if (session.end_ms <= session.start_ms) continue
    const date = nightDateOf(session)
    if (date) byDate.set(date, [...(byDate.get(date) ?? []), session])
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, list]) => {
      const bySource = new Map<string, number>()
      for (const session of list) bySource.set(session.source, (bySource.get(session.source) ?? 0) + asleepMsOf(session))
      const primary = [...bySource.entries()].sort((a, b) => b[1] - a[1])[0]![0]
      return nightOf(date, list.filter((session) => session.source === primary))
    })
}

// ── 按时间点记的读数 ──────────────────────────────────────────────────────────

/** 每天的均值(心率变异性按天平均,即「HRV」的读法)。 */
export function dailyAverage(samples: readonly NativeHealthSample[]): Map<string, number> {
  const sums = new Map<string, { total: number; count: number }>()
  for (const sample of samples) {
    const date = localDate(sample.time_ms)
    const acc = sums.get(date) ?? { total: 0, count: 0 }
    sums.set(date, { total: acc.total + sample.value, count: acc.count + 1 })
  }
  return new Map([...sums.entries()].map(([date, { total, count }]) => [date, Math.round((total / count) * 10) / 10]))
}

export function latestSample(samples: readonly NativeHealthSample[], digits = 1): HealthLatest | null {
  const last = [...samples].sort((a, b) => a.time_ms - b.time_ms).at(-1)
  if (!last) return null
  const scale = 10 ** digits
  return { value: Math.round(last.value * scale) / scale, at: localIso(last.time_ms) }
}

// ── 锻炼 ─────────────────────────────────────────────────────────────────────

export function buildWorkouts(sessions: readonly NativeExerciseSession[], limit = 10): HealthWorkout[] {
  return [...sessions]
    .filter((s) => s.end_ms > s.start_ms)
    .sort((a, b) => b.start_ms - a.start_ms)
    .slice(0, limit)
    .map((s) => ({
      exercise_type: s.exercise_type,
      name: exerciseName(s.exercise_type),
      title: s.title,
      start: localIso(s.start_ms),
      end: localIso(s.end_ms),
      minutes: minutes(s.end_ms - s.start_ms),
      active_kcal: s.active_kcal ?? null,
      distance_m: s.distance_m ?? null,
      steps: s.steps ?? null,
      hr_avg: s.hr_avg ?? null,
      hr_max: s.hr_max ?? null,
      source: s.source,
    }))
}

// ── 合起来:health.summary ────────────────────────────────────────────────────

export interface HealthSummaryInput {
  now: number
  /** 交出去的最近几天(含今天)。 */
  days: number
  status: NativeHealthStatus
  /** 从「days + 基线那 14 天」的第一天起,每天一格(升序)。 */
  daily: NativeHealthDay[]
  sleep: NativeSleepSession[]
  hrv: NativeHealthSample[]
  exercise: NativeExerciseSession[]
  body: Partial<Record<'weight' | 'body_fat' | 'oxygen_saturation' | 'respiratory_rate', NativeHealthSample[]>>
  unreadable: Array<{ type: string; message: string }>
}

const SIGNAL_OF: Record<HealthSignalKey, (day: HealthDay) => number | null> = {
  sleep: (d) => d.sleep_minutes,
  steps: (d) => d.steps,
  resting_hr: (d) => d.resting_hr,
  hrv: (d) => d.hrv_ms,
  active_kcal: (d) => d.active_kcal,
}

export function buildHealthSummary(input: HealthSummaryInput): HealthSummary {
  const nights = buildNights(input.sleep)
  const sleepByDate = new Map(nights.map((n) => [n.date, n.asleep_minutes]))
  const hrvByDate = dailyAverage(input.hrv)
  const all: HealthDay[] = input.daily.map((d) => ({
    date: d.date,
    steps: d.steps ?? null,
    distance_m: d.distance_m ?? null,
    active_kcal: d.active_kcal ?? null,
    resting_hr: d.resting_hr ?? null,
    hr_avg: d.hr_avg ?? null,
    hr_min: d.hr_min ?? null,
    hr_max: d.hr_max ?? null,
    hrv_ms: hrvByDate.get(d.date) ?? null,
    exercise_minutes: d.exercise_ms === null || d.exercise_ms === undefined ? null : minutes(d.exercise_ms),
    sleep_minutes: sleepByDate.get(d.date) ?? null,
  }))
  const shown = all.slice(-input.days)
  const granted = new Set<string>(input.status.granted_types)
  const signalTypes: Record<HealthSignalKey, HealthType> = { sleep: 'sleep', steps: 'steps', resting_hr: 'resting_heart_rate', hrv: 'hrv', active_kcal: 'active_calories' }
  const signals: HealthSignal[] = (Object.keys(SIGNAL_OF) as HealthSignalKey[])
    .filter((key) => granted.has(signalTypes[key]))
    .map((key) => {
      const pick = SIGNAL_OF[key]
      // 步数 / 活动消耗:看今天(还没过完,不和基线比);其余看最近一个有数据的那天,和它之前那几天比。
      const cumulative = key === 'steps' || key === 'active_kcal'
      const index = cumulative ? all.length - 1 : findLastIndex(all, (d) => pick(d) !== null)
      const day = index >= 0 ? all[index]! : null
      const value = day ? pick(day) : null
      const history = index >= 0 ? all.slice(0, index).map(pick) : []
      const { baseline, status } = cumulative
        ? { baseline: baselineStatus(key, null, all.slice(0, -1).map(pick)).baseline, status: null }
        : baselineStatus(key, value, history)
      return {
        key,
        date: day?.date ?? null,
        value,
        unit: SIGNAL_UNITS[key],
        baseline: baseline === null ? null : Math.round(baseline),
        status,
        series: shown.map((d) => ({ date: d.date, value: pick(d) })),
      }
    })
  const today = localDate(input.now)
  const lastNight = nights.at(-1) ?? null
  const firstShown = shown[0]?.date ?? today
  return {
    v: HEALTH_SUMMARY_VERSION,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown',
    generated_at: localIso(input.now),
    range: { start_date: firstShown, end_date: today },
    granted_types: input.status.granted_types,
    missing_types: HEALTH_TYPES.filter((type) => !granted.has(type)),
    background: { supported: input.status.background_supported, granted: input.status.background_granted },
    days: shown,
    last_night: lastNight && lastNight.date >= firstShown ? lastNight : null,
    signals,
    workouts: buildWorkouts(input.exercise.filter((s) => localDate(s.start_ms) >= firstShown)),
    body: {
      weight_kg: latestSample(input.body.weight ?? []),
      body_fat_pct: latestSample(input.body.body_fat ?? []),
      oxygen_saturation_pct: latestSample(input.body.oxygen_saturation ?? []),
      respiratory_rate: latestSample(input.body.respiratory_rate ?? []),
    },
    unreadable: input.unreadable,
  }
}

function findLastIndex<T>(list: readonly T[], test: (item: T) => boolean): number {
  for (let i = list.length - 1; i >= 0; i -= 1) if (test(list[i]!)) return i
  return -1
}

// ── 读原生 ───────────────────────────────────────────────────────────────────

/** 读一类;读失败记进 unreadable(❌ 当成没有数据),权限类的错往上抛(那是整组都读不了)。 */
async function readOrNote<T>(type: string, unreadable: HealthSummaryInput['unreadable'], run: () => Promise<T[]>): Promise<T[]> {
  try {
    return await run()
  } catch (error) {
    const failure = nativeFailure(error)
    if (failure.code === 'os_permission') throw error
    unreadable.push({ type, message: failure.message })
    return []
  }
}

export const HEALTH_SUMMARY_MAX_DAYS = 14
const BASELINE_DAYS = 14

export async function readHealthSummary(days: number, status: NativeHealthStatus, now = Date.now()): Promise<HealthSummary> {
  const granted = new Set<string>(status.granted_types)
  const firstDay = localDayStartMs(now, -(days - 1 + BASELINE_DAYS))
  const unreadable: HealthSummaryInput['unreadable'] = []
  const daily = await nativePhoneActions.healthDaily({ start_date: localDate(firstDay), days: days + BASELINE_DAYS })
  // 睡眠从第一天的前一天中午起读:那一晚的上床时间在前一天。
  const sleepFrom = firstDay - DAY_MS / 2
  const sample = (type: HealthSampleType, from: number) =>
    granted.has(type) ? readOrNote(type, unreadable, async () => (await nativePhoneActions.healthSamples({ type, start_ms: from, end_ms: now })).samples) : Promise.resolve([])
  const [sleep, hrv, exercise, weight, bodyFat, oxygen, respiratory] = await Promise.all([
    granted.has('sleep') ? readOrNote('sleep', unreadable, async () => (await nativePhoneActions.healthSleep({ start_ms: sleepFrom, end_ms: now })).sessions) : Promise.resolve([]),
    sample('hrv', firstDay),
    granted.has('exercise')
      ? readOrNote('exercise', unreadable, async () => (await nativePhoneActions.healthExercise({ start_ms: localDayStartMs(now, -(days - 1)), end_ms: now, limit: 20 })).sessions)
      : Promise.resolve([]),
    // 体重 / 体脂 / 血氧 / 呼吸不是天天量:往前看 30 天,取最近一次。
    sample('weight', now - 30 * DAY_MS),
    sample('body_fat', now - 30 * DAY_MS),
    sample('oxygen_saturation', now - 30 * DAY_MS),
    sample('respiratory_rate', now - 30 * DAY_MS),
  ])
  return buildHealthSummary({
    now,
    days,
    status,
    daily: daily.days,
    sleep,
    hrv,
    exercise,
    body: { weight, body_fat: bodyFat, oxygen_saturation: oxygen, respiratory_rate: respiratory },
    unreadable,
  })
}
