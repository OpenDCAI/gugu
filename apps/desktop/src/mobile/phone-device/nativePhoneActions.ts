// #7199 手机当设备 —— 原生 GuguPhoneActionsPlugin 的网页这一侧。原生只管真去做与系统权限;
// 收发规矩、咕咕里的授权、最近调用都在这个目录的其余文件里。
import { registerPlugin, type PermissionState } from '@capacitor/core'

/** 要向系统申请的运行时权限(插件里的别名)。 */
export type PhoneRuntimePermission = 'calendar' | 'contacts' | 'location'
/** 读系统时多看一样 coarseLocation:只给了「大致位置」时 location 不算 granted(那个别名要精确 + 大致两样),单独认一下。 */
export type PhonePermissionAlias = PhoneRuntimePermission | 'coarseLocation'

export interface PhoneDeviceInfo {
  manufacturer: string
  brand: string
  model: string
  android: string
  sdk: number
  rom: string | null
  device_name: string | null
  app_version: string | null
  package: string
  /** 这台手机这个咕咕的系统标识(ANDROID_ID)的摘要:只在本机比对安装标识是不是从别的手机的备份里恢复来的,❌ 上传。 */
  install_key: string | null
}

/** 那几样要去系统设置里开的(运行时权限之外)。 */
export interface PhoneSpecialStatus {
  notification_listener: boolean
  dnd_access: boolean
  location_enabled: boolean
  background_location: boolean
  alarm_app: boolean
  foreground: boolean
}

export type PhoneSettingsTarget = 'app' | 'notification_listener' | 'dnd' | 'location' | 'health'

/** 健康:咕咕读 Health Connect 的哪几类(与原生 HealthTypes.PERMISSIONS 同名同序)。 */
export const HEALTH_TYPES = [
  'steps', 'distance', 'active_calories', 'heart_rate', 'resting_heart_rate', 'hrv', 'sleep', 'exercise',
  'oxygen_saturation', 'respiratory_rate', 'weight', 'body_fat',
] as const
export type HealthType = (typeof HEALTH_TYPES)[number]

/** 这台手机的 Health Connect:有没有(安卓 14 起系统自带)、给了哪几类、能不能在后台读。 */
export interface NativeHealthStatus {
  supported: boolean
  granted_types: HealthType[]
  background_supported: boolean
  background_granted: boolean
  /** 网页这一侧补的:这个安装包的原生还没有健康这几个方法(网页比包新)。 */
  old_app?: boolean
}

export interface NativeHealthDay {
  date: string
  steps?: number | null
  distance_m?: number | null
  active_kcal?: number | null
  hr_avg?: number | null
  hr_min?: number | null
  hr_max?: number | null
  resting_hr?: number | null
  exercise_ms?: number | null
}

export type NativeSleepStage = 'awake' | 'sleeping' | 'out_of_bed' | 'light' | 'deep' | 'rem' | 'awake_in_bed' | 'unknown'

export interface NativeSleepSession {
  start_ms: number
  end_ms: number
  source: string
  title: string | null
  stages: Array<{ start_ms: number; end_ms: number; stage: NativeSleepStage }>
}

export interface NativeExerciseSession {
  start_ms: number
  end_ms: number
  source: string
  exercise_type: number
  title: string | null
  steps?: number | null
  distance_m?: number | null
  active_kcal?: number | null
  hr_avg?: number | null
  hr_max?: number | null
}

/** 按时间点记的那几类(一次一个读数)。 */
export type HealthSampleType = 'hrv' | 'oxygen_saturation' | 'respiratory_rate' | 'weight' | 'body_fat'

/** value:心率变异性毫秒、血氧 %、呼吸次/分、体重千克、体脂 %。 */
export interface NativeHealthSample {
  time_ms: number
  value: number
  source: string
}

export interface NativeHeartRateBucket {
  start_ms: number
  end_ms: number
  avg: number
  min: number | null
  max: number | null
}

export interface NativeCalendarEvent {
  event_id: string
  title: string
  start_ms: number
  end_ms: number
  all_day: boolean
  location: string
  description: string
  calendar: string
  calendar_id: string
}

export interface NativeContact {
  contact_id: string
  name: string
  phones: string[]
  emails: string[]
}

export interface NativeLocation {
  latitude: number
  longitude: number
  accuracy_m: number | null
  provider: string
  fixed_at_ms: number
  cached: boolean
  coordinate_system: 'WGS84'
  address: string | null
}

export interface NativeNotification {
  key: string
  app: string
  package: string
  title: string
  text: string
  posted_at: number
  ongoing: boolean
  active: boolean
}

export type DndMode = 'off' | 'priority' | 'alarms' | 'silent'

interface GuguPhoneActionsPlugin {
  checkPermissions(): Promise<Record<PhonePermissionAlias, PermissionState>>
  requestPermissions(options: { permissions: PhoneRuntimePermission[] }): Promise<Record<PhonePermissionAlias, PermissionState>>
  deviceInfo(): Promise<PhoneDeviceInfo>
  specialStatus(): Promise<PhoneSpecialStatus>
  openSettings(options: { target: PhoneSettingsTarget }): Promise<void>
  /** 「通知与勿扰」连着才记新通知;断开当场清空原生那边记下的。 */
  setNotificationCollecting(options: { on: boolean }): Promise<void>
  calendarList(options: { start_ms: number; end_ms: number; limit?: number }): Promise<{ events: NativeCalendarEvent[]; timezone: string }>
  calendarCreate(options: Record<string, unknown>): Promise<{ event_id: string; calendar_id: string }>
  calendarUpdate(options: Record<string, unknown>): Promise<{ event_id: string }>
  calendarDelete(options: { event_id: string }): Promise<{ event_id: string }>
  contactsList(options: { query?: string; limit?: number }): Promise<{ contacts: NativeContact[] }>
  locationCurrent(options: { timeout_ms?: number }): Promise<NativeLocation>
  notificationsList(options: { limit?: number }): Promise<{ notifications: NativeNotification[] }>
  dndSet(options: { mode: DndMode }): Promise<{ before: DndMode; mode: DndMode }>
  alarmSet(options: { hour: number; minute: number; label?: string }): Promise<Record<string, never>>
  timerStart(options: { seconds: number; label?: string }): Promise<Record<string, never>>
  healthStatus(): Promise<NativeHealthStatus>
  /** 弹 Health Connect 的授权页;回来后交此刻给了哪几类。 */
  healthRequest(): Promise<NativeHealthStatus>
  healthDaily(options: { start_date: string; days: number }): Promise<{ timezone: string; days: NativeHealthDay[]; granted_types: HealthType[] }>
  healthSleep(options: { start_ms: number; end_ms: number }): Promise<{ timezone: string; sessions: NativeSleepSession[] }>
  healthExercise(options: { start_ms: number; end_ms: number; limit?: number }): Promise<{ timezone: string; sessions: NativeExerciseSession[] }>
  healthSamples(options: { type: HealthSampleType; start_ms: number; end_ms: number }): Promise<{ timezone: string; samples: NativeHealthSample[] }>
  healthHeartRate(options: { start_ms: number; end_ms: number; bucket_minutes: number }): Promise<{ timezone: string; buckets: NativeHeartRateBucket[] }>
}

export const nativePhoneActions = registerPlugin<GuguPhoneActionsPlugin>('GuguPhoneActions')

/** 原生 reject 时带的码(见 GuguPhoneActionsPlugin 头注释)。 */
export type NativeFailureCode = 'os_permission' | 'invalid_args' | 'needs_foreground' | 'unavailable' | 'failed'

const NATIVE_CODES: readonly NativeFailureCode[] = ['os_permission', 'invalid_args', 'needs_foreground', 'unavailable', 'failed']

/** Capacitor 把 reject(message, code) 交成带 code 的 Error;认不出的一律当 failed。 */
export function nativeFailure(error: unknown): { code: NativeFailureCode; message: string } {
  const raw = error as { code?: unknown; message?: unknown } | null
  const code = NATIVE_CODES.find((known) => known === raw?.code) ?? 'failed'
  const message = typeof raw?.message === 'string' && raw.message ? raw.message : String(error)
  return { code, message }
}
