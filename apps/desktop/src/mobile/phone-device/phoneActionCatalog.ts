/**
 * #7199 手机当设备 —— 这台手机登记给云端的动作清单,以及每个动作在安卓上怎么做。
 *
 * 清单的形状是线上合同(@gugu/core/shared/deviceActions):桌面、咕咕 server、手机三端同一个名字指同一件事。
 * 当前九类:日历、通讯录、定位、通知与勿扰、闹钟、健康、短信、已有录音与照片/视频。
 * 媒体按 Android 的分类授权读取,不开放所有文件访问。
 *
 * 规矩(《手机当设备》§5「做的话要守的规矩」):
 *  · 没授权的动作也登记,标不可用并说清为什么 —— 助理始终知道这台手机本来能做什么、现在为什么不能做;
 *  · 需要确认的动作遵循调用入口的确认契约;本机 Pi 只接受当前 owner 在任务时间线对确切参数的批准,模型自行填写 confirmed 不能代替批准;
 *  · 只在被调用时读,❌ 在后台整份上传。
 *
 * 这里的 title / description / unavailable_detail 是交给云端(助理和别的端)的数据,不是本机界面文案 ——
 * 本机界面的字在 i18n 的 phoneDevice.*。
 */
import type { PermissionState } from '@capacitor/core'
import {
  DEVICE_ACTION_CONFIRMED_ARG,
  DEVICE_ACTION_PROTOCOL_VERSION,
  type DeviceActionConfirmPolicy,
  type DeviceActionErrorCode,
  type DeviceActionManifestEntry,
  type DeviceActionRisk,
  type DeviceActionsCapability,
  type DeviceActionUnavailableReason,
} from '@gugu/core/shared/deviceActions'
import {
  nativeFailure,
  type DndMode,
  type NativeCalendarEvent,
  type PhonePermissionAlias,
  type PhoneRuntimePermission,
  type PhoneSpecialStatus,
  type NativeHealthStatus,
  nativePhoneActions,
} from './nativePhoneActions'
import { PHONE_DATA_ACTIONS, NO_PHONE_DATA, phoneDataAllowed, type PhoneDataStatus } from './phoneDataActions'
import { HEALTH_SUMMARY_MAX_DAYS, buildNights, buildWorkouts, latestSample, readHealthSummary } from './phoneHealth'
import { localDate, localDayStartMs } from './phoneTime'
import { localIso, pad, utcOffsetOf } from './phoneTime'
import { phoneCalendarEventView } from './phoneCalendarView'

/** 授权分组:设置里一组一个开关(按「连接器」授权的粒度)。 */
export const PHONE_ACTION_GROUPS = ['calendar', 'contacts', 'location', 'notifications', 'alarm', 'health', 'sms', 'recordings', 'photos'] as const
export type PhoneActionGroup = (typeof PHONE_ACTION_GROUPS)[number]

/** 一个动作要这台手机给的那一样东西。 */
export type PhoneRequirement = PhoneRuntimePermission | 'notification_listener' | 'dnd_access' | 'alarm_app' | 'health_connect' | 'sms' | 'recordings' | 'photos'

/** 系统当下给了什么:运行时权限 + 要去系统设置里开的那几样。 */
export interface PhoneOsState {
  runtime: Record<PhonePermissionAlias, PermissionState>
  special: PhoneSpecialStatus
  /** Health Connect:有没有、给了哪几类(给一类就算连上,缺的在结果里说)。 */
  health: NativeHealthStatus
  data?: PhoneDataStatus
}

/** 执行失败:带合同里的码,message 是给助理与人看的一句话。 */
export class PhoneActionFailure extends Error {
  constructor(readonly code: DeviceActionErrorCode, message: string) {
    super(message)
    this.name = 'PhoneActionFailure'
  }
}

export interface PhoneActionDefinition {
  name: string
  group: PhoneActionGroup
  title: string
  description: (ctx: PhoneCatalogContext) => string
  risk: DeviceActionRisk
  confirm: DeviceActionConfirmPolicy
  input_schema: Record<string, unknown>
  requires: PhoneRequirement
  /** confirm = always 时:要人点头的那一句(参数不对就抛 invalid_args,❌ 拿坏参数去问人)。 */
  confirmQuestion?: (args: Record<string, unknown>) => { question: string; details?: unknown }
  run: (args: Record<string, unknown>) => Promise<unknown>
}

export interface PhoneCatalogContext {
  /** 手机所在时区(IANA)与此刻的 UTC 偏移,写进日历动作的说明:助理在云电脑上,时区未必一样。 */
  timezone: string
  utcOffset: string
}

// ── 时间 ─────────────────────────────────────────────────────────────────────

export { localIso, utcOffsetOf } from './phoneTime'

/** 全天日程在系统日历里存的是 UTC 零点:日期按 UTC 读。 */
const utcDate = (ms: number) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

function invalid(message: string): never {
  throw new PhoneActionFailure('invalid_args', message)
}

/** 带偏移的 ISO,或不带偏移(按手机所在时区读)。 */
function parseInstant(value: unknown, field: string): number {
  if (typeof value !== 'string' || !value.trim()) invalid(`${field} 要是 ISO 时间,例如 2026-10-16T15:00:00+08:00`)
  const ms = Date.parse(value.trim())
  if (!Number.isFinite(ms)) invalid(`${field} 不是能读的时间:${value}`)
  return ms
}

/** `YYYY-MM-DD` → 手机本地那天零点。 */
function localDayStart(value: unknown, field: string): number {
  const match = typeof value === 'string' ? DATE_ONLY.exec(value.trim()) : null
  if (!match) invalid(`${field} 要是 YYYY-MM-DD`)
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  if (date.getFullYear() !== Number(match[1]) || date.getMonth() !== Number(match[2]) - 1 || date.getDate() !== Number(match[3])) invalid(`${field} 不是有效日期`)
  return date.getTime()
}

/** `YYYY-MM-DD` → 那天的 UTC 零点(全天日程的存法)。 */
function utcDayStart(value: unknown, field: string): number {
  const match = typeof value === 'string' ? DATE_ONLY.exec(value.trim()) : null
  if (!match) invalid(`${field} 要是 YYYY-MM-DD`)
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])))
  if (date.getUTCFullYear() !== Number(match[1]) || date.getUTCMonth() !== Number(match[2]) - 1 || date.getUTCDate() !== Number(match[3])) invalid(`${field} 不是有效日期`)
  return date.getTime()
}

const DAY_MS = 24 * 3600_000

function optionalText(args: Record<string, unknown>, field: string): string | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string') invalid(`${field} 要是文字`)
  return value
}

function optionalInt(args: Record<string, unknown>, field: string, min: number, max: number): number | undefined {
  const value = args[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(`${field} 要是 ${min}–${max} 的整数`)
  return value
}

function requiredText(args: Record<string, unknown>, field: string): string {
  const value = optionalText(args, field)
  if (!value || !value.trim()) invalid(`缺 ${field}`)
  return value.trim()
}

/** 原生 reject → 合同里的码。要前台 / 没有时钟 App 这类,合同里没有专门的码,归执行失败,message 说清。 */
async function callNative<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    const failure = nativeFailure(error)
    const code: DeviceActionErrorCode = failure.code === 'os_permission' || failure.code === 'invalid_args' ? failure.code : 'execution_failed'
    throw new PhoneActionFailure(code, failure.message)
  }
}

/**
 * 系统按 UTC 零点到零点存全天日程,按区间查时只要和「手机本地的这一天」在 UTC 上沾边就会被带出来
 * (东八区查 16 号,会带出 15 号的全天日程)。全天的按日期再比一次:日期区间和本地日期区间有交集才留。
 */
function allDayOverlaps(event: NativeCalendarEvent, start: number, end: number): boolean {
  if (!event.all_day) return true
  const firstDay = localIso(start).slice(0, 10)
  const lastDay = localIso(end - 1).slice(0, 10)
  return utcDate(event.start_ms) <= lastDay && utcDate(event.end_ms) > firstDay
}

function describeWhen(args: Record<string, unknown>): string {
  if (args.all_day === true) return typeof args.start === 'string' ? `${args.start} 全天` : '全天'
  const start = parseInstant(args.start, 'start')
  const end = args.end === undefined || args.end === null ? null : parseInstant(args.end, 'end')
  return end === null ? localIso(start) : `${localIso(start)} – ${localIso(end)}`
}

const DND_NAMES: Record<DndMode, string> = {
  off: '关闭勿扰',
  priority: '勿扰(只放行重要的人和闹钟)',
  alarms: '只响闹钟',
  silent: '完全静音',
}

const isDndMode = (value: unknown): value is DndMode => value === 'off' || value === 'priority' || value === 'alarms' || value === 'silent'

const withConfirmed = (properties: Record<string, unknown>) => ({
  ...properties,
  [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: '用户已在聊天里同意(先不带它调一次,拿到 needs_confirmation 的问题去问人,同意后带 true 再调)' },
})

// ── 清单 ─────────────────────────────────────────────────────────────────────

export const PHONE_ACTIONS: readonly PhoneActionDefinition[] = [
  {
    name: 'calendar.events.list',
    group: 'calendar',
    title: '查手机日历里的日程',
    description: (ctx) =>
      `列出这台手机日历里某段时间的日程(含各账户同步来的)。给 date(YYYY-MM-DD,那一整天)或 start / end(ISO,带偏移;不带按手机时区);都不给 = 今天起 7 天。手机时区 ${ctx.timezone}(UTC${ctx.utcOffset})。回 events:定时日程带 start / end(手机本地时间),全天日程带 start_date / end_date(end_date 不含)。`,
    risk: 'low',
    confirm: 'never',
    requires: 'calendar',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD,查这一整天' },
        start: { type: 'string', description: '起点,ISO 8601' },
        end: { type: 'string', description: '终点,ISO 8601' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 100 },
      },
    },
    run: async (args) => {
      let start: number
      let end: number
      if (args.date !== undefined) {
        if (args.start !== undefined || args.end !== undefined) invalid('date 与 start/end 只能选一种')
        start = localDayStart(args.date, 'date')
        const day = new Date(start)
        end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1).getTime()
      } else if (args.start !== undefined || args.end !== undefined) {
        start = args.start !== undefined ? parseInstant(args.start, 'start') : Date.now()
        end = args.end !== undefined ? parseInstant(args.end, 'end') : start + 7 * DAY_MS
      } else {
        const today = new Date()
        start = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
        end = start + 7 * DAY_MS
      }
      if (end <= start) invalid('end 要晚于 start')
      const limit = optionalInt(args, 'limit', 1, 500) ?? 100
      const result = await callNative(() => nativePhoneActions.calendarList({ start_ms: start, end_ms: end, limit }))
      return {
        timezone: result.timezone,
        range: { start: localIso(start), end: localIso(end) },
        events: result.events.filter((event) => allDayOverlaps(event, start, end)).map(phoneCalendarEventView),
      }
    },
  },
  {
    name: 'calendar.events.create',
    group: 'calendar',
    title: '在手机日历里建日程',
    description: (ctx) =>
      `在这台手机的日历里建一条日程(写进主日历,或 calendar_id 指定的那本)。定时日程给 start / end(ISO,带偏移;不带按手机时区,end 缺省 = 一小时后);全天日程给 all_day: true 和 start / end(YYYY-MM-DD,end 不含,缺省 = 当天)。reminder_minutes = 提前几分钟提醒。手机时区 ${ctx.timezone}(UTC${ctx.utcOffset})。回 event_id。`,
    risk: 'medium',
    confirm: 'always',
    requires: 'calendar',
    input_schema: {
      type: 'object',
      required: ['title', 'start'],
      properties: withConfirmed({
        title: { type: 'string' },
        start: { type: 'string', description: 'ISO 8601;全天日程为 YYYY-MM-DD' },
        end: { type: 'string', description: 'ISO 8601;全天日程为 YYYY-MM-DD(不含)' },
        all_day: { type: 'boolean', default: false },
        location: { type: 'string' },
        description: { type: 'string' },
        reminder_minutes: { type: 'integer', minimum: 0, maximum: 40320 },
        calendar_id: { type: 'string', description: 'calendar.events.list 回的 calendar_id 不给;一般不用填' },
      }),
    },
    confirmQuestion: (args) => {
      const title = requiredText(args, 'title')
      return { question: `要在手机日历里建「${title}」(${describeWhen(args)})吗?` }
    },
    run: async (args) => {
      const title = requiredText(args, 'title')
      const allDay = args.all_day === true
      let start: number
      let end: number
      if (allDay) {
        start = utcDayStart(args.start, 'start')
        end = args.end !== undefined && args.end !== null ? utcDayStart(args.end, 'end') : start + DAY_MS
      } else {
        start = parseInstant(args.start, 'start')
        end = args.end !== undefined && args.end !== null ? parseInstant(args.end, 'end') : start + 3600_000
      }
      if (end <= start) invalid('end 要晚于 start')
      const created = await callNative(() => nativePhoneActions.calendarCreate({
        title,
        start_ms: start,
        end_ms: end,
        all_day: allDay,
        location: optionalText(args, 'location'),
        description: optionalText(args, 'description'),
        reminder_minutes: optionalInt(args, 'reminder_minutes', 0, 40320),
        calendar_id: optionalText(args, 'calendar_id'),
      }))
      return { event_id: created.event_id, title, ...(allDay ? { start_date: utcDate(start), end_date: utcDate(end) } : { start: localIso(start), end: localIso(end) }) }
    },
  },
  {
    name: 'calendar.events.update',
    group: 'calendar',
    title: '改手机日历里的日程',
    description: (ctx) =>
      `改这台手机日历里的一条日程(event_id 来自 calendar.events.list)。只改给了的字段;start / end 为 ISO,带偏移(不带按手机时区 ${ctx.timezone})。重复日程会整串一起改。`,
    risk: 'medium',
    confirm: 'always',
    requires: 'calendar',
    input_schema: {
      type: 'object',
      required: ['event_id'],
      properties: withConfirmed({
        event_id: { type: 'string' },
        title: { type: 'string' },
        start: { type: 'string' },
        end: { type: 'string' },
        location: { type: 'string' },
        description: { type: 'string' },
      }),
    },
    confirmQuestion: (args) => {
      requiredText(args, 'event_id')
      const changes: string[] = []
      if (typeof args.title === 'string') changes.push(`标题改成「${args.title}」`)
      if (args.start !== undefined) changes.push(`开始改到 ${localIso(parseInstant(args.start, 'start'))}`)
      if (args.end !== undefined) changes.push(`结束改到 ${localIso(parseInstant(args.end, 'end'))}`)
      if (typeof args.location === 'string') changes.push(`地点改成「${args.location}」`)
      if (typeof args.description === 'string') changes.push('改备注')
      if (changes.length === 0) invalid('没有要改的字段')
      return { question: `要改手机日历里的这条日程吗:${changes.join(',')}?`, details: { event_id: args.event_id } }
    },
    run: async (args) => {
      const eventId = requiredText(args, 'event_id')
      const payload: Record<string, unknown> = { event_id: eventId }
      const title = optionalText(args, 'title')
      if (title !== undefined) payload.title = title
      if (args.start !== undefined) payload.start_ms = parseInstant(args.start, 'start')
      if (args.end !== undefined) payload.end_ms = parseInstant(args.end, 'end')
      const location = optionalText(args, 'location')
      if (location !== undefined) payload.location = location
      const description = optionalText(args, 'description')
      if (description !== undefined) payload.description = description
      if (Object.keys(payload).length === 1) invalid('没有要改的字段')
      return callNative(() => nativePhoneActions.calendarUpdate(payload))
    },
  },
  {
    name: 'calendar.events.delete',
    group: 'calendar',
    title: '删手机日历里的日程',
    description: () => '删掉这台手机日历里的一条日程(event_id 来自 calendar.events.list)。重复日程会整串删掉。',
    risk: 'medium',
    confirm: 'always',
    requires: 'calendar',
    input_schema: {
      type: 'object',
      required: ['event_id'],
      properties: withConfirmed({ event_id: { type: 'string' } }),
    },
    confirmQuestion: (args) => ({ question: '要删掉手机日历里的这条日程吗?', details: { event_id: requiredText(args, 'event_id') } }),
    run: async (args) => callNative(() => nativePhoneActions.calendarDelete({ event_id: requiredText(args, 'event_id') })),
  },
  {
    name: 'contacts.list',
    group: 'contacts',
    title: '查手机通讯录',
    description: () => '查这台手机通讯录里的联系人(只读)。给 query 按名字、电话、邮箱查;不给按名字排序列出。回 contacts:name、phones、emails。',
    risk: 'low',
    confirm: 'never',
    requires: 'contacts',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
      },
    },
    run: async (args) => {
      const query = optionalText(args, 'query')
      const limit = optionalInt(args, 'limit', 1, 500) ?? 50
      return callNative(() => nativePhoneActions.contactsList({ ...(query ? { query } : {}), limit }))
    },
  },
  {
    name: 'location.current',
    group: 'location',
    title: '取手机现在的位置',
    description: () =>
      '取这台手机此刻的位置(系统定位,最多等 timeout_ms,默认 15 秒;现取不到时退回 10 分钟内系统记着的最近一次,cached: true)。回 latitude / longitude(WGS84,国内地图要 GCJ-02 得自己换算)、accuracy_m、fixed_at(手机本地时间)、address(手机系统反查的地址,很多国内手机没有这项服务,常为 null)。',
    risk: 'medium',
    confirm: 'always',
    requires: 'location',
    input_schema: {
      type: 'object',
      properties: withConfirmed({ timeout_ms: { type: 'integer', minimum: 2000, maximum: 60000, default: 15000 } }),
    },
    confirmQuestion: () => ({ question: '要读一下手机现在的位置吗?' }),
    run: async (args) => {
      const timeout = optionalInt(args, 'timeout_ms', 2000, 60000) ?? 15000
      const fix = await callNative(() => nativePhoneActions.locationCurrent({ timeout_ms: timeout }))
      return {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy_m: fix.accuracy_m,
        coordinate_system: fix.coordinate_system,
        fixed_at: localIso(fix.fixed_at_ms),
        cached: fix.cached,
        address: fix.address,
      }
    },
  },
  {
    name: 'notifications.list',
    group: 'notifications',
    title: '读手机上的通知',
    description: () =>
      '读这台手机通知栏里还挂着的通知,加上咕咕开着期间收到的最近 200 条(新的在前;咕咕自己的通知不算)。app 按 App 名或包名筛。回 notifications:app、title、text、posted_at(手机本地时间)、active(还挂在通知栏里)。',
    risk: 'low',
    confirm: 'never',
    requires: 'notification_listener',
    input_schema: {
      type: 'object',
      properties: {
        app: { type: 'string', description: 'App 名或包名,例如「微信」或 com.tencent.mm' },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 30 },
      },
    },
    run: async (args) => {
      const app = optionalText(args, 'app')?.trim().toLowerCase()
      const limit = optionalInt(args, 'limit', 1, 200) ?? 30
      const result = await callNative(() => nativePhoneActions.notificationsList({ limit: app ? 200 : limit }))
      const rows = result.notifications
        .filter((n) => !app || n.app.toLowerCase().includes(app) || n.package.toLowerCase() === app)
        .slice(0, limit)
      return {
        notifications: rows.map((n) => ({
          app: n.app,
          package: n.package,
          title: n.title,
          text: n.text,
          posted_at: localIso(n.posted_at),
          active: n.active,
        })),
      }
    },
  },
  {
    name: 'dnd.set',
    group: 'notifications',
    title: '开关手机的勿扰',
    description: () =>
      '改这台手机的勿扰。mode:off = 关勿扰;priority = 勿扰(只放行重要联系人和闹钟,一般说的「开勿扰」就是这个);alarms = 只响闹钟;silent = 完全静音。回 before / mode。',
    risk: 'medium',
    confirm: 'always',
    requires: 'dnd_access',
    input_schema: {
      type: 'object',
      required: ['mode'],
      properties: withConfirmed({ mode: { type: 'string', enum: ['off', 'priority', 'alarms', 'silent'] } }),
    },
    confirmQuestion: (args) => {
      if (!isDndMode(args.mode)) invalid('mode 只能是 off / priority / alarms / silent')
      return { question: `要把手机改成「${DND_NAMES[args.mode]}」吗?` }
    },
    run: async (args) => {
      if (!isDndMode(args.mode)) invalid('mode 只能是 off / priority / alarms / silent')
      const mode = args.mode
      return callNative(() => nativePhoneActions.dndSet({ mode }))
    },
  },
  {
    name: 'alarm.set',
    group: 'alarm',
    title: '在手机上设闹钟',
    description: () => '在这台手机的时钟 App 里设一个闹钟(hour 0–23、minute 0–59,label 是闹钟名)。安卓只许前台的 App 拉起时钟:手机上的咕咕不在前台时会失败,请人打开咕咕再试。',
    risk: 'low',
    confirm: 'never',
    requires: 'alarm_app',
    input_schema: {
      type: 'object',
      required: ['hour', 'minute'],
      properties: {
        hour: { type: 'integer', minimum: 0, maximum: 23 },
        minute: { type: 'integer', minimum: 0, maximum: 59 },
        label: { type: 'string' },
      },
    },
    run: async (args) => {
      const hour = optionalInt(args, 'hour', 0, 23)
      const minute = optionalInt(args, 'minute', 0, 59)
      if (hour === undefined || minute === undefined) invalid('要有 hour 和 minute')
      const label = optionalText(args, 'label')
      await callNative(() => nativePhoneActions.alarmSet({ hour, minute, ...(label ? { label } : {}) }))
      return { hour, minute, ...(label ? { label } : {}) }
    },
  },
  {
    name: 'timer.start',
    group: 'alarm',
    title: '在手机上开倒计时',
    description: () => '在这台手机的时钟 App 里开一个倒计时(seconds 1–86400,label 是名字)。同闹钟:手机上的咕咕要在前台。',
    risk: 'low',
    confirm: 'never',
    requires: 'alarm_app',
    input_schema: {
      type: 'object',
      required: ['seconds'],
      properties: {
        seconds: { type: 'integer', minimum: 1, maximum: 86400 },
        label: { type: 'string' },
      },
    },
    run: async (args) => {
      const seconds = optionalInt(args, 'seconds', 1, 86400)
      if (seconds === undefined) invalid('要有 seconds')
      const label = optionalText(args, 'label')
      await callNative(() => nativePhoneActions.timerStart({ seconds, ...(label ? { label } : {}) }))
      return { seconds, ...(label ? { label } : {}) }
    },
  },

  // ── 健康(Health Connect,只读;常用的那几类)────────────────────────
  {
    name: 'health.summary',
    group: 'health',
    title: '看手机里的健康数据概况',
    description: () =>
      '这台手机 Health Connect 里最近几天的健康概况(days 1–14,默认 7;含今天)。回 days:每天的步数、距离(米)、活动消耗(千卡)、静息心率、心率均值 / 最低 / 最高、心率变异性(HRV,毫秒)、锻炼分钟、睡眠分钟(记在醒来那天:「昨晚」= 今天);last_night:最近一晚的上床 / 醒来时间、卧床与睡着分钟、分期(深睡 / 浅睡 / 快速眼动 / 清醒,分钟);signals:睡眠、步数、静息心率、HRV、活动消耗的最新值、过去 14 天的基线(中位数)与状态 status(optimal 很棒 / typical 正常 / above 略高 / below 略低 / high 较高 / low 较低;步数和活动消耗是今天还没过完,不给状态);workouts:锻炼;body:最近一次体重、体脂、血氧、呼吸频率。missing_types = 用户在 Health Connect 里没给的那几类,unreadable = 这次读失败的那几类(如实告诉用户,别当成没有数据)。值为 null = 那天没有记录。回答「我昨晚睡得怎么样」「这周步数」先调它。',
    risk: 'low',
    confirm: 'never',
    requires: 'health_connect',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: HEALTH_SUMMARY_MAX_DAYS, default: 7 } },
    },
    run: async (args) => {
      const days = optionalInt(args, 'days', 1, HEALTH_SUMMARY_MAX_DAYS) ?? 7
      const status = await callNative(() => nativePhoneActions.healthStatus())
      return callNative(() => readHealthSummary(days, status))
    },
  },
  {
    name: 'health.sleep',
    group: 'health',
    title: '看手机里记的睡眠',
    description: () =>
      '这台手机 Health Connect 里的睡眠,一晚一条(记在醒来那天)。date(YYYY-MM-DD)= 那天早上醒来的那一晚,默认今天(= 昨晚);days(1–14,默认 1)= 从 date 往前几晚。回 nights:上床 / 醒来(手机本地时间)、卧床分钟、睡着分钟、分期分钟(deep 深睡 / light 浅睡 / rem 快速眼动 / awake 清醒 / asleep_unstaged 只记了睡着没分期;stages 为 null = 这个来源不分期)、来源 App 的包名。',
    risk: 'low',
    confirm: 'never',
    requires: 'health_connect',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD,醒来那天' },
        days: { type: 'integer', minimum: 1, maximum: 14, default: 1 },
      },
    },
    run: async (args) => {
      const end = args.date !== undefined ? localDayStart(args.date, 'date') + DAY_MS : localDayStartMs(Date.now(), 1)
      const days = optionalInt(args, 'days', 1, 14) ?? 1
      const start = end - days * DAY_MS - DAY_MS / 2
      const result = await callNative(() => nativePhoneActions.healthSleep({ start_ms: start, end_ms: Math.min(end, Date.now()) }))
      const firstDate = localDate(end - days * DAY_MS)
      return { timezone: result.timezone, nights: buildNights(result.sessions).filter((n) => n.date >= firstDate && n.date < localDate(end)) }
    },
  },
  {
    name: 'health.workouts',
    group: 'health',
    title: '看手机里记的锻炼',
    description: () =>
      '这台手机 Health Connect 里的锻炼记录(新的在前)。days(1–30,默认 7;含今天)。回 workouts:name(中文,如跑步、骑行、力量训练)、开始 / 结束(手机本地时间)、分钟、这段时间里的活动消耗(千卡)、距离(米)、步数、平均 / 最高心率(没给对应权限或没记 = null)、来源 App。',
    risk: 'low',
    confirm: 'never',
    requires: 'health_connect',
    input_schema: {
      type: 'object',
      properties: {
        days: { type: 'integer', minimum: 1, maximum: 30, default: 7 },
        limit: { type: 'integer', minimum: 1, maximum: 50, default: 20 },
      },
    },
    run: async (args) => {
      const days = optionalInt(args, 'days', 1, 30) ?? 7
      const limit = optionalInt(args, 'limit', 1, 50) ?? 20
      const now = Date.now()
      const result = await callNative(() => nativePhoneActions.healthExercise({ start_ms: localDayStartMs(now, -(days - 1)), end_ms: now, limit: 100 }))
      return { timezone: result.timezone, workouts: buildWorkouts(result.sessions, limit) }
    },
  },
  {
    name: 'health.heart_rate',
    group: 'health',
    title: '看手机里记的心率',
    description: () =>
      '这台手机 Health Connect 里某一天的心率,按 bucket_minutes(5–240,默认 60)分段的均值 / 最低 / 最高(次/分)。date(YYYY-MM-DD)默认今天。没有记录的时段不列出。',
    risk: 'low',
    confirm: 'never',
    requires: 'health_connect',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD' },
        bucket_minutes: { type: 'integer', minimum: 5, maximum: 240, default: 60 },
      },
    },
    run: async (args) => {
      const start = args.date !== undefined ? localDayStart(args.date, 'date') : localDayStartMs(Date.now())
      const bucket = optionalInt(args, 'bucket_minutes', 5, 240) ?? 60
      const end = Math.min(start + DAY_MS, Date.now())
      if (end <= start) invalid('date 不能是将来的日子')
      const result = await callNative(() => nativePhoneActions.healthHeartRate({ start_ms: start, end_ms: end, bucket_minutes: bucket }))
      return {
        timezone: result.timezone,
        date: localDate(start),
        buckets: result.buckets.map((b) => ({ start: localIso(b.start_ms), end: localIso(b.end_ms), avg: b.avg, min: b.min, max: b.max })),
      }
    },
  },
  {
    name: 'health.body',
    group: 'health',
    title: '看手机里记的体重与体征',
    description: () =>
      '这台手机 Health Connect 里最近 days 天(1–30,默认 30)的体重(千克)、体脂(%)、血氧饱和度(%)、呼吸频率(次/分):每样回最近一次 latest 和每次的读数 samples(手机本地时间)。没给权限的那几样不读,在 missing_types 里。',
    risk: 'low',
    confirm: 'never',
    requires: 'health_connect',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 30, default: 30 } },
    },
    run: async (args) => {
      const days = optionalInt(args, 'days', 1, 30) ?? 30
      const now = Date.now()
      const status = await callNative(() => nativePhoneActions.healthStatus())
      const granted = new Set<string>(status.granted_types)
      const kinds = ['weight', 'body_fat', 'oxygen_saturation', 'respiratory_rate'] as const
      const out: Record<string, unknown> = { missing_types: kinds.filter((k) => !granted.has(k)) }
      for (const type of kinds.filter((k) => granted.has(k))) {
        const result = await callNative(() => nativePhoneActions.healthSamples({ type, start_ms: now - days * DAY_MS, end_ms: now }))
        out[type] = { latest: latestSample(result.samples), samples: result.samples.map((x) => ({ at: localIso(x.time_ms), value: Math.round(x.value * 10) / 10 })) }
      }
      return out
    },
  },
  ...PHONE_DATA_ACTIONS,
]

export function phoneActionByName(name: string): PhoneActionDefinition | undefined {
  return PHONE_ACTIONS.find((action) => action.name === name)
}

export function actionsOfGroup(group: PhoneActionGroup): PhoneActionDefinition[] {
  return PHONE_ACTIONS.filter((action) => action.group === group)
}

/** 每组要这台手机给的那几样(设置页一行一样,「去授权」)。 */
export function requirementsOfGroup(group: PhoneActionGroup): PhoneRequirement[] {
  return [...new Set(actionsOfGroup(group).map((action) => action.requires))]
}

// ── 可用性 ───────────────────────────────────────────────────────────────────

/** 精确或大致位置给了一样就行:「我在哪」用大致位置(城区级)也答得上。 */
function locationGranted(os: PhoneOsState): boolean {
  return os.runtime.location === 'granted' || os.runtime.coarseLocation === 'granted'
}

export function requirementGranted(requirement: PhoneRequirement, os: PhoneOsState): boolean {
  switch (requirement) {
    case 'sms':
    case 'recordings':
    case 'photos':
      return phoneDataAllowed(requirement, os.data ?? NO_PHONE_DATA)
    case 'calendar':
    case 'contacts':
      return os.runtime[requirement] === 'granted'
    case 'location':
      return locationGranted(os)
    case 'notification_listener':
      return os.special.notification_listener
    case 'dnd_access':
      return os.special.dnd_access
    case 'alarm_app':
      return os.special.alarm_app
    case 'health_connect':
      return os.health.supported && os.health.granted_types.length > 0
  }
}

/** 这一组还缺系统给的哪几样(设置页「去授权」;时钟 App 不是授权补得上的,单独说)。 */
export function missingRequirements(group: PhoneActionGroup, os: PhoneOsState | null): PhoneRequirement[] {
  if (!os) return []
  return requirementsOfGroup(group).filter(
    (requirement) => !(['sms', 'recordings', 'photos'].includes(requirement) && !os.data?.supported) && requirement !== 'alarm_app' && !(requirement === 'health_connect' && !os.health.supported) && !requirementGranted(requirement, os),
  )
}

const OPEN_IN_GUGU = '在手机上的咕咕里打开 我的 → 这台手机'

export function requirementMet(
  requirement: PhoneRequirement,
  os: PhoneOsState,
): { ok: true } | { ok: false; reason: Exclude<DeviceActionUnavailableReason, 'not_granted'>; detail: string } {
  switch (requirement) {
    case 'sms':
    case 'recordings':
    case 'photos': {
      const data = os.data ?? NO_PHONE_DATA
      if (!data.supported) return { ok: false, reason: 'unsupported', detail: '手机上的咕咕版本还不支持读取短信、录音和相册,请更新手机 App' }
      return phoneDataAllowed(requirement, data) ? { ok: true } : { ok: false, reason: 'os_permission', detail: requirement === 'sms' ? `系统没给短信权限,也可能是安装来源不允许授予:${OPEN_IN_GUGU} → 短信 → 去授权` : `系统没给读取权限:${OPEN_IN_GUGU} → ${requirement === 'photos' ? '相册' : '录音'} → 去授权` }
    }
    case 'calendar':
      return os.runtime.calendar === 'granted' ? { ok: true } : { ok: false, reason: 'os_permission', detail: `系统没给咕咕日历权限:${OPEN_IN_GUGU} → 日历 → 去授权` }
    case 'contacts':
      return os.runtime.contacts === 'granted' ? { ok: true } : { ok: false, reason: 'os_permission', detail: `系统没给咕咕通讯录权限:${OPEN_IN_GUGU} → 通讯录 → 去授权` }
    case 'location':
      if (!locationGranted(os)) return { ok: false, reason: 'os_permission', detail: `系统没给咕咕定位权限:${OPEN_IN_GUGU} → 定位 → 去授权` }
      return os.special.location_enabled ? { ok: true } : { ok: false, reason: 'os_permission', detail: '手机的定位总开关没开(下拉通知栏打开「位置信息」)' }
    case 'notification_listener':
      return os.special.notification_listener ? { ok: true } : { ok: false, reason: 'os_permission', detail: `没给咕咕「通知使用权」:${OPEN_IN_GUGU} → 通知与勿扰 → 去授权` }
    case 'dnd_access':
      return os.special.dnd_access ? { ok: true } : { ok: false, reason: 'os_permission', detail: `没给咕咕「勿扰权限」:${OPEN_IN_GUGU} → 通知与勿扰 → 去授权` }
    case 'alarm_app':
      return os.special.alarm_app ? { ok: true } : { ok: false, reason: 'unsupported', detail: '这台手机上没有能设闹钟的时钟 App' }
    case 'health_connect':
      if (!os.health.supported) {
        return {
          ok: false,
          reason: 'unsupported',
          detail: os.health.old_app ? '这台手机上的咕咕版本太旧,还读不了健康数据:更新手机上的咕咕后再试' : '这台手机没有 Health Connect(安卓 14 起系统自带),读不了健康数据',
        }
      }
      return os.health.granted_types.length > 0
        ? { ok: true }
        : { ok: false, reason: 'os_permission', detail: `没在 Health Connect 里给咕咕读健康数据:${OPEN_IN_GUGU} → 健康 → 去授权` }
  }
}

export type PhoneGroupGrants = Record<PhoneActionGroup, boolean>

export function catalogContext(now: Date = new Date()): PhoneCatalogContext {
  return { timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown', utcOffset: utcOffsetOf(now) }
}

/** 这台手机此刻的登记清单(写进设备行 capabilities.actions):没授权的也登记、标不可用并说清为什么。 */
export function buildPhoneActionsCapability(grants: PhoneGroupGrants, os: PhoneOsState, now: Date = new Date()): DeviceActionsCapability {
  const ctx = catalogContext(now)
  const actions: DeviceActionManifestEntry[] = PHONE_ACTIONS.map((action) => {
    const base = {
      name: action.name,
      group: action.group,
      title: action.title,
      description: action.description(ctx),
      risk: action.risk,
      confirm: action.confirm,
      input_schema: action.input_schema,
    }
    if (!grants[action.group]) {
      return { ...base, available: false, unavailable_reason: 'not_granted', unavailable_detail: `用户没在咕咕里打开这一组:${OPEN_IN_GUGU},连上「${GROUP_WIRE_NAMES[action.group]}」` }
    }
    const met = requirementMet(action.requires, os)
    return met.ok ? { ...base, available: true } : { ...base, available: false, unavailable_reason: met.reason, unavailable_detail: met.detail }
  })
  return { v: DEVICE_ACTION_PROTOCOL_VERSION, updated_at: now.toISOString(), timezone: ctx.timezone, actions }
}

/** 组名(给助理看的那份,和设置页上的组名一致)。 */
const GROUP_WIRE_NAMES: Record<PhoneActionGroup, string> = {
  calendar: '日历',
  contacts: '通讯录',
  location: '定位',
  notifications: '通知与勿扰',
  alarm: '闹钟',
  health: '健康',
  sms: '短信',
  recordings: '录音',
  photos: '相册',
}

/** 清单里决定「可用 / 为什么不可用」的那部分 —— 它变了才需要立刻重新登记(updated_at 每次都变,不算)。 */
export function capabilityFingerprint(capability: DeviceActionsCapability): string {
  return capability.actions.map((a) => `${a.name}:${a.available ? 1 : 0}:${a.unavailable_reason ?? ''}`).join('|') + `#${capability.actions[0]?.description ?? ''}`
}
