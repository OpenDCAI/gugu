/**
 * 日历(calendar.* 13 个):EventKit 经咕咕的原生助手(native/mac-helper Calendar.swift)。
 * 参数名是三端合同,手机端同名同义:建 / 改日程用 title / start / end / all_day / calendar / location / notes / url /
 * alarms_minutes_before,改 / 删用 event_id + span —— ❌ 换成 summary / startDateTime 之类的别名。
 * 重复日程的某一次:event_id = 「calendarItemIdentifier@那一次的开始时间」,原生助手按它找回那一次。
 *
 * 删除(日程 / 整个日历)「每次先问你」(confirm:'always'),但问句要说出真名,光凭参数(只有 id)说不出来:
 * 所以标 confirmsItself —— provider 不在开工前拦,动作自己没带 confirmed 一律先读出那一条、回 needs_confirmation;
 * 原生助手那边删除也只认 confirmed: true,两道都过才删。
 */
import { DEVICE_ACTION_CONFIRMED_ARG } from '@gugu/core/shared/deviceActions'
import {
  bad,
  MAC_PRIVACY,
  ok,
  requestHelperPermission,
  str,
  TIME_HINT,
  type ActionFamily,
  type Args,
  type FamilyContext,
  type Outcome,
} from '../catalog'

// ── 日历与提醒事项共用(reminders.ts 也用) ──────────────────────────────────────────

export const CONFIRMED_PROP = { [DEVICE_ACTION_CONFIRMED_ARG]: { type: 'boolean', description: 'Set only after the person agreed in the chat to the confirm.question you got.' } }

export function helper<T>(ctx: FamilyContext, method: string, params: Record<string, unknown>): Promise<T> {
  return ctx.deps.macHelper().call<T>(method, params, { signal: ctx.signal, timeoutMs: 60_000 })
}

/** 去掉没给的键(发给原生助手的参数一眼看得清;null 留着 = 清空)。 */
export function defined(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined))
}

/** 给了才发:字符串原样(去首尾空白,'' = 清空),没给 = undefined。 */
export const optText = (args: Args, key: string): string | undefined => (typeof args[key] === 'string' ? (args[key] as string).trim() : undefined)

export const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
/** 本地时间的毫秒数:只有日期 = 当地那天 0 点(Date.parse 会把纯日期当成 UTC)。 */
export const localMs = (text: string): number => Date.parse(DATE_ONLY.test(text) ? `${text}T00:00:00` : text)
export const isTime = (text: string): boolean => text.length > 0 && Number.isFinite(localMs(text))

/** 给人看的时间:10月16日 15:00;只有日期就只写日期;不是今年的带上年份。 */
export function whenZh(iso: string, now: Date): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/.exec(iso)
  if (!m) return iso
  const day = `${Number(m[1]) === now.getFullYear() ? '' : `${m[1]}年`}${Number(m[2])}月${Number(m[3])}日`
  return m[4] ? `${day} ${m[4]}:${m[5]}` : day
}

export const sameTitle = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** 先问人:什么都还没做。 */
export function askFirst(message: string, question: string, details: unknown): Outcome {
  return { ok: false, code: 'needs_confirmation', message, confirm: { question, details } }
}
export const ASK_MESSAGE = (what: string) =>
  `Nothing was ${what} yet: ask the person the confirm.question in the chat; only if they agree, call again with the same args plus confirmed: true.`

export const RECURRENCE_SCHEMA = {
  type: 'object',
  description: 'Repeat rule, e.g. {"frequency":"weekly","days_of_week":["MO"]}. On update {"frequency":"none"} stops repeating.',
  required: ['frequency'],
  properties: {
    frequency: { type: 'string', enum: ['daily', 'weekly', 'monthly', 'yearly', 'none'] },
    interval: { type: 'integer', minimum: 1, maximum: 999, description: 'Every N days/weeks/… (default 1)' },
    days_of_week: { type: 'array', items: { type: 'string', enum: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] } },
    until: { type: 'string', description: 'Last day (inclusive), ISO 8601 date' },
    count: { type: 'integer', minimum: 1, description: 'Number of occurrences (instead of until)' },
  },
  additionalProperties: false,
}

export function recurrenceProblem(value: unknown): string | null {
  if (value === undefined) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) return 'recurrence must be an object like {"frequency":"weekly","days_of_week":["MO"]}'
  const r = value as Record<string, unknown>
  if (!['daily', 'weekly', 'monthly', 'yearly', 'none'].includes(String(r.frequency))) return 'recurrence.frequency must be daily / weekly / monthly / yearly / none'
  if (r.interval !== undefined && (!Number.isInteger(r.interval) || (r.interval as number) < 1 || (r.interval as number) > 999)) return 'recurrence.interval must be an integer 1–999'
  if (r.until !== undefined && (typeof r.until !== 'string' || !isTime(r.until))) return 'recurrence.until must be an ISO 8601 date'
  if (r.count !== undefined && (!Number.isInteger(r.count) || (r.count as number) < 1)) return 'recurrence.count must be a positive integer'
  if (r.until !== undefined && r.count !== undefined) return 'recurrence takes until or count, not both'
  if (r.days_of_week !== undefined && (!Array.isArray(r.days_of_week) || r.days_of_week.some((d) => !['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'].includes(String(d))))) {
    return 'recurrence.days_of_week takes MO TU WE TH FR SA SU'
  }
  return null
}

export const LIMIT_PROP = { type: 'integer', minimum: 1, maximum: 500, description: 'Page size (default 50, max 500)' }
export const CURSOR_PROP = { type: 'string', description: 'next_cursor from the previous page' }
export function pageProblem(args: Args): string | null {
  if (args.cursor !== undefined && !(typeof args.cursor === 'string' && /^\d+$/.test(args.cursor))) return 'cursor must be the next_cursor value from the previous page'
  if (args.limit !== undefined && !(Number.isInteger(args.limit) && (args.limit as number) >= 1 && (args.limit as number) <= 500)) return 'limit must be an integer 1–500'
  return null
}
export const pageParams = (args: Args) => ({
  limit: typeof args.limit === 'number' ? args.limit : undefined,
  offset: typeof args.cursor === 'string' ? Number(args.cursor) : undefined,
})

const stringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((v) => typeof v === 'string' && v.trim().length > 0)

/** 容器(日历 / 提醒列表)一行:原生助手 containerRow。 */
export interface ContainerRow {
  id: string
  name: string
  writable: boolean
  is_default: boolean
  immutable: boolean
  source?: { id: string; name: string; type: string }
}

// ── 日历 ────────────────────────────────────────────────────────────────────────

interface EventRow {
  event_id: string
  title: string
  start: string
  end: string
  all_day: boolean
  calendar: string
  calendar_id: string
  recurring: boolean
  availability?: string
  status?: string
  my_status?: string
  attendee_count?: number
}

/** 10月16日 15:00–16:00 / 10月16日 全天 / 10月16日 – 10月18日 全天。 */
function eventWhen(e: EventRow, now: Date): string {
  if (e.all_day) return !e.end || e.end.slice(0, 10) === e.start.slice(0, 10) ? `${whenZh(e.start, now)} 全天` : `${whenZh(e.start, now)} – ${whenZh(e.end, now)} 全天`
  return e.start.slice(0, 10) === e.end.slice(0, 10) ? `${whenZh(e.start, now)}–${e.end.slice(11, 16)}` : `${whenZh(e.start, now)} – ${whenZh(e.end, now)}`
}

const brief = (e: EventRow) => ({ event_id: e.event_id, title: e.title, start: e.start, end: e.end, all_day: e.all_day, calendar: e.calendar })

/**
 * 建日程前看一眼那段时间:撞了时间的(全天、空闲、我已谢绝、已取消的不算)与同名的。
 * 全天日程只查同一天里同名的全天日程(全天不占时段)。
 */
async function findClashes(ctx: FamilyContext, input: { title: string; start: string; end?: string; allDay: boolean }): Promise<EventRow[]> {
  if (input.allDay) {
    const first = input.start.slice(0, 10)
    const last = (input.end ?? input.start).slice(0, 10)
    const r = await helper<{ events: EventRow[] }>(ctx, 'calendar.events.list', { start: first, end: last, include_declined: true, limit: 500 })
    return r.events.filter((e) => e.all_day && sameTitle(e.title, input.title) && e.start.slice(0, 10) <= last && e.end.slice(0, 10) >= first)
  }
  const from = localMs(input.start)
  const to = input.end ? localMs(input.end) : from + 3_600_000
  const r = await helper<{ events: EventRow[] }>(ctx, 'calendar.events.list', {
    start: input.start,
    end: input.end ?? new Date(to).toISOString(),
    include_declined: true,
    limit: 500,
  })
  return r.events.filter((e) =>
    !e.all_day
    && e.status !== 'canceled'
    && e.my_status !== 'declined'
    && (e.availability !== 'free' || sameTitle(e.title, input.title))
    && localMs(e.start) < to
    && localMs(e.end) > from)
}

function deleteQuestion(e: EventRow, span: string | undefined, now: Date): string {
  const others = e.attendee_count ? `它有 ${e.attendee_count} 位参与者，删除可能会通知到他们。` : ''
  if (!e.recurring) return `要删除日程「${e.title}」（${eventWhen(e, now)}）吗？${others}`
  const at = whenZh(e.start, now)
  return span === 'future'
    ? `要删除重复日程「${e.title}」从 ${at} 起的这一次及以后各次吗？${others}`
    : `要删除重复日程「${e.title}」${at} 的这一次吗？${others}`
}

const SPAN_PROP = { type: 'string', enum: ['this', 'future'], description: 'Recurring events only (required for them): this = only this occurrence, future = this and all later ones' }
const ALARMS_PROP = {
  type: 'array',
  maxItems: 10,
  items: { type: 'number' },
  description: 'Alerts, in minutes before start (e.g. [15]; 0 = at start). For all-day events counted from 00:00 that day, so -540 = 09:00 that day.',
}

function alarmsProblem(value: unknown): string | null {
  if (value === undefined) return null
  if (!Array.isArray(value) || value.length > 10 || value.some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < -1440 || n > 40_320)) {
    return 'alarms_minutes_before must be an array of up to 10 numbers between -1440 and 40320 (minutes before start)'
  }
  return null
}

const urlProblem = (args: Args) => {
  const url = optText(args, 'url')
  return url && !/^[a-z][a-z0-9+.-]*:/i.test(url) ? 'url must be an absolute URL (https://…)' : null
}

/** 建 / 改共用的检查。 */
function eventFieldsProblem(args: Args, creating: boolean): string | null {
  const start = str(args, 'start')
  const end = str(args, 'end')
  if (creating && !str(args, 'title')) return 'title is required'
  if (creating && !start) return `start is required (${TIME_HINT})`
  if (start && !isTime(start)) return `start must be ${TIME_HINT}`
  if (end && !isTime(end)) return `end must be ${TIME_HINT}`
  if (start && end) {
    if (args.all_day === true || (DATE_ONLY.test(start) && DATE_ONLY.test(end))) {
      if (end.slice(0, 10) < start.slice(0, 10)) return 'for all_day events end is the last day and must not be before start'
    } else if (localMs(end) <= localMs(start)) {
      return 'end must be after start'
    }
  }
  if (args.all_day !== undefined && typeof args.all_day !== 'boolean') return 'all_day must be true or false'
  return alarmsProblem(args.alarms_minutes_before) ?? urlProblem(args) ?? recurrenceProblem(args.recurrence)
}

/** 发给原生助手的日程字段(建 / 改同一套)。creating:空串不发;改:空串 = 清空。 */
function eventFields(args: Args, creating: boolean) {
  const text = (key: string) => (creating ? str(args, key) || undefined : optText(args, key))
  return {
    title: str(args, 'title') || undefined,
    start: str(args, 'start') || undefined,
    end: str(args, 'end') || undefined,
    all_day: typeof args.all_day === 'boolean' ? args.all_day : undefined,
    calendar: str(args, 'calendar') || undefined,
    location: text('location'),
    notes: text('notes'),
    url: text('url'),
    alarms_minutes_before: Array.isArray(args.alarms_minutes_before) ? args.alarms_minutes_before : undefined,
    recurrence: args.recurrence,
  }
}

const EVENT_PROPS = {
  title: { type: 'string' },
  start: { type: 'string', description: `Start. ${TIME_HINT} For all_day a date (2026-10-16).` },
  end: { type: 'string', description: 'End (same format as start). Timed: defaults to 1 hour after start. all_day: the last day, inclusive.' },
  all_day: { type: 'boolean' },
  calendar: { type: 'string', description: 'Calendar name or id from calendar.list' },
  location: { type: 'string' },
  notes: { type: 'string' },
  url: { type: 'string' },
  alarms_minutes_before: ALARMS_PROP,
  recurrence: RECURRENCE_SCHEMA,
}

const COLOR_PROP = { type: 'string', description: 'Hex color like #FF9500' }
const colorProblem = (args: Args) => (args.color !== undefined && !/^#?[0-9a-f]{6}$/i.test(str(args, 'color')) ? 'color must be a hex color like #FF9500' : null)

export function createCalendarFamily(): ActionFamily {
  return {
    groups: [{
      id: 'calendar',
      platforms: ['darwin'],
      needs: 'macHelper',
      iconApp: '/System/Applications/Calendar.app',
      settingsUrl: MAC_PRIVACY('Privacy_Calendars'),
      osPermission: '系统设置 → 隐私与安全性 → 日历 → 打开咕咕（完全访问）',
      probe: (ctx) => requestHelperPermission(ctx, 'calendar', '日历'),
    }],
    actions: [
      {
        name: 'calendar.status',
        succeedsWithoutPermission: true,
        group: 'calendar',
        title: '日历授权状态',
        titleEn: 'Calendar status',
        description: 'Read whether 咕咕 may use this Mac\'s Calendar, without prompting: authorization (granted / denied / not_determined / restricted / write_only), full_access, timezone, and with access the default calendar and the number of calendars. Use it to explain os_permission failures.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, ctx) => ok(await helper(ctx, 'calendar.status', {})),
      },
      {
        name: 'calendar.sources.list',
        group: 'calendar',
        title: '列出日历账户',
        titleEn: 'List calendar accounts',
        description: 'List the calendar accounts on this Mac (iCloud, Exchange, Google/CalDAV, On My Mac, subscribed, birthdays): id, name, type and the ids of their calendars. A source id goes into calendar.calendars.create as source_id.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', properties: {}, additionalProperties: false },
        run: async (_args, ctx) => ok(await helper(ctx, 'calendar.sources', {})),
      },
      {
        name: 'calendar.list',
        group: 'calendar',
        title: '列出日历',
        titleEn: 'List calendars',
        description: 'List the calendars on this Mac: id, name, color, account (source), writable, is_default (where new events go when calendar is omitted), subscribed, immutable. Filters: writable_only, source_id. A calendar\'s name or id is what calendar takes in the calendar.events.* actions.',
        risk: 'low',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: { writable_only: { type: 'boolean' }, source_id: { type: 'string', description: 'Only calendars of this account (calendar.sources.list)' } },
          additionalProperties: false,
        },
        run: async (args, ctx) => ok(await helper(ctx, 'calendar.calendars.list', defined({
          writable_only: typeof args.writable_only === 'boolean' ? args.writable_only : undefined,
          source_id: str(args, 'source_id') || undefined,
        }))),
      },
      {
        name: 'calendar.calendars.get',
        group: 'calendar',
        title: '查看日历',
        titleEn: 'Get calendar',
        description: 'Read one calendar (the container, not its events) by its exact id from calendar.list: same fields as a calendar.list row.',
        risk: 'low',
        confirm: 'never',
        input_schema: { type: 'object', required: ['calendar_id'], properties: { calendar_id: { type: 'string' } }, additionalProperties: false },
        validate: (args) => (str(args, 'calendar_id') ? null : 'calendar_id is required (from calendar.list)'),
        run: async (args, ctx) => ok(await helper(ctx, 'calendar.calendars.get', { calendar_id: str(args, 'calendar_id') })),
      },
      {
        name: 'calendar.calendars.create',
        group: 'calendar',
        title: '新建日历',
        titleEn: 'Create calendar',
        description: 'Create a new, empty calendar (a container for events). name is required; color is a hex like #FF9500; source_id picks the account (calendar.sources.list; default = the account of the default calendar — some accounts refuse new calendars). If a calendar with that name already exists it returns needs_confirmation first. Returns the new calendar row.',
        risk: 'medium',
        confirm: 'on_conflict',
        input_schema: {
          type: 'object',
          required: ['name'],
          properties: { name: { type: 'string' }, color: COLOR_PROP, source_id: { type: 'string' }, ...CONFIRMED_PROP },
          additionalProperties: false,
        },
        validate: (args) => (str(args, 'name') ? colorProblem(args) : 'name is required'),
        async run(args, ctx) {
          const name = str(args, 'name')
          const sourceId = str(args, 'source_id') || undefined
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const { calendars } = await helper<{ calendars: ContainerRow[] }>(ctx, 'calendar.calendars.list', {})
            const same = calendars.filter((c) => sameTitle(c.name, name) && (!sourceId || c.source?.id === sourceId))
            if (same.length > 0) {
              const where = same.map((c) => c.source?.name).filter(Boolean).join('、')
              return askFirst(ASK_MESSAGE('created'), `已经有叫「${name}」的日历${where ? `（${where}）` : ''}，还要再建一个同名的吗？`, { existing: same })
            }
          }
          return ok(await helper(ctx, 'calendar.calendars.create', defined({ name, color: str(args, 'color') || undefined, source_id: sourceId })))
        },
      },
      {
        name: 'calendar.calendars.update',
        group: 'calendar',
        title: '改日历',
        titleEn: 'Update calendar',
        description: 'Rename and/or recolor a calendar by its exact id from calendar.list (name, color as #RRGGBB; at least one). System and subscribed calendars cannot be changed. Returns the updated calendar row.',
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          required: ['calendar_id'],
          properties: { calendar_id: { type: 'string' }, name: { type: 'string' }, color: COLOR_PROP },
          additionalProperties: false,
        },
        validate: (args) => {
          if (!str(args, 'calendar_id')) return 'calendar_id is required (from calendar.list)'
          if (!str(args, 'name') && !str(args, 'color')) return 'pass name and/or color'
          return colorProblem(args)
        },
        run: async (args, ctx) => ok(await helper(ctx, 'calendar.calendars.update', defined({
          calendar_id: str(args, 'calendar_id'),
          name: str(args, 'name') || undefined,
          color: str(args, 'color') || undefined,
        }))),
      },
      {
        name: 'calendar.calendars.delete',
        group: 'calendar',
        title: '删除日历',
        titleEn: 'Delete calendar',
        description: 'Delete a whole calendar AND every event in it, by its exact id from calendar.list. The person is always asked first: without confirmed: true nothing is deleted and it returns needs_confirmation naming the calendar and its account; ask them, and only if they agree call again with the same args plus confirmed: true.',
        risk: 'high',
        confirm: 'always',
        confirmsItself: true,
        input_schema: { type: 'object', required: ['calendar_id'], properties: { calendar_id: { type: 'string' }, ...CONFIRMED_PROP }, additionalProperties: false },
        validate: (args) => (str(args, 'calendar_id') ? null : 'calendar_id is required (from calendar.list)'),
        async run(args, ctx) {
          const id = str(args, 'calendar_id')
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const cal = await helper<ContainerRow>(ctx, 'calendar.calendars.get', { calendar_id: id })
            if (cal.immutable) return bad(`"${cal.name}" is a system calendar and cannot be deleted.`)
            const where = cal.source?.name ? `（${cal.source.name}）` : ''
            const isDefault = cal.is_default ? '它是新日程默认放进去的日历。' : ''
            return askFirst(ASK_MESSAGE('deleted'), `要删除日历「${cal.name}」${where}和里面的全部日程吗？删了不能撤销。${isDefault}`, { calendar: cal })
          }
          ctx.note('正在删除日历…')
          return ok(await helper(ctx, 'calendar.calendars.delete', { calendar_id: id, confirmed: true }))
        },
      },
      {
        name: 'calendar.events.list',
        group: 'calendar',
        title: '查日程',
        titleEn: 'List events',
        description: `List events in a time window, recurring events expanded into their occurrences, sorted by start. start / end: ${TIME_HINT} A date-only end includes that whole day; default window = today 00:00 plus 14 days (only end given: the 14 days before it; max ~10 years). Filters: calendar (name or id), calendar_ids, query (matches title / location / notes), include_declined (default false hides invitations the person declined). Each event: event_id (for get / update / delete / export), title, start, end, all_day, calendar, calendar_id, location, notes (first 300 chars), recurring, organizer, attendee_count / my_status when it is an invitation. Pages: limit (default 50), then next_cursor as cursor while has_more.`,
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: {
            start: { type: 'string' },
            end: { type: 'string' },
            calendar: { type: 'string', description: 'Calendar name or id' },
            calendar_ids: { type: 'array', items: { type: 'string' } },
            query: { type: 'string' },
            include_declined: { type: 'boolean' },
            limit: LIMIT_PROP,
            cursor: CURSOR_PROP,
          },
          additionalProperties: false,
        },
        validate: (args) => {
          const start = str(args, 'start')
          const end = str(args, 'end')
          if (start && !isTime(start)) return `start must be ${TIME_HINT}`
          if (end && !isTime(end)) return `end must be ${TIME_HINT}`
          if (start && end && localMs(end) + (DATE_ONLY.test(end) ? 86_400_000 : 0) <= localMs(start)) return 'end must be after start'
          if (args.calendar_ids !== undefined && !stringList(args.calendar_ids)) return 'calendar_ids must be an array of calendar ids'
          return pageProblem(args)
        },
        run: async (args, ctx) => ok(await helper(ctx, 'calendar.events.list', defined({
          start: str(args, 'start') || undefined,
          end: str(args, 'end') || undefined,
          calendar: str(args, 'calendar') || undefined,
          calendar_ids: stringList(args.calendar_ids) ? args.calendar_ids : undefined,
          query: str(args, 'query') || undefined,
          include_declined: typeof args.include_declined === 'boolean' ? args.include_declined : undefined,
          ...pageParams(args),
        }))),
      },
      {
        name: 'calendar.events.get',
        group: 'calendar',
        title: '看日程',
        titleEn: 'Get event',
        description: 'Read one event (or one occurrence of a recurring event) by event_id from calendar.events.list: everything list returns plus notes (up to 2000 chars), attendees (name, email, status; up to 20), organizer, alarms, recurrence (RRULE), time_zone, external_id.',
        risk: 'medium',
        confirm: 'never',
        input_schema: { type: 'object', required: ['event_id'], properties: { event_id: { type: 'string' } }, additionalProperties: false },
        validate: (args) => (str(args, 'event_id') ? null : 'event_id is required (from calendar.events.list)'),
        run: async (args, ctx) => ok(await helper(ctx, 'calendar.events.get', { event_id: str(args, 'event_id') })),
      },
      {
        name: 'calendar.events.create',
        group: 'calendar',
        title: '建日程',
        titleEn: 'Create event',
        description: `Create an event in this Mac's Calendar. title and start are required; start / end: ${TIME_HINT} end defaults to 1 hour after start. all_day: true makes an all-day event: pass dates, end = the last day (inclusive, may equal start). calendar: name or id from calendar.list (default = the person's default calendar). Optional location, notes, url, alarms_minutes_before, recurrence. It first looks at that time: if other events overlap (all-day, free, declined and cancelled ones ignored) or one with the same title is there, nothing is created and it returns needs_confirmation listing them — ask the person, and only if they still want it call again with the same args plus confirmed: true. Returns the created event (event_id, title, start, end, calendar …).`,
        risk: 'medium',
        confirm: 'on_conflict',
        input_schema: { type: 'object', required: ['title', 'start'], properties: { ...EVENT_PROPS, ...CONFIRMED_PROP }, additionalProperties: false },
        validate: (args) => eventFieldsProblem(args, true),
        async run(args, ctx) {
          const fields = eventFields(args, true)
          const title = str(args, 'title')
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const clashes = await findClashes(ctx, { title, start: str(args, 'start'), end: fields.end, allDay: args.all_day === true })
            if (clashes.length > 0) {
              const now = ctx.deps.now()
              const names = clashes.slice(0, 3).map((e) => `「${e.title}」（${eventWhen(e, now)}）`).join('、')
              const more = clashes.length > 3 ? ` 等 ${clashes.length} 个日程` : ''
              return askFirst(
                `Nothing was created yet: ${clashes.length} event(s) already at that time (confirm.details.clashes). Ask the person the confirm.question; only if they still want it, call again with the same args plus confirmed: true.`,
                `这段时间已经有${names}${more}，还要建「${title}」吗？`,
                { clashes: clashes.slice(0, 20).map(brief) },
              )
            }
          }
          ctx.note('正在建日程…')
          return ok(await helper(ctx, 'calendar.events.create', defined(fields)))
        },
      },
      {
        name: 'calendar.events.update',
        group: 'calendar',
        title: '改日程',
        titleEn: 'Update event',
        description: `Change an event by event_id (from calendar.events.list / get). Only the fields you pass change; changing only start keeps the duration. calendar moves it to another calendar (name or id). alarms_minutes_before replaces all alerts ([] removes them); an empty string clears location / notes / url; recurrence {"frequency":"none"} stops repeating. Recurring events need span: "this" (only this occurrence) or "future" (this and all later ones). Times: ${TIME_HINT} Returns the updated event plus changed (field names); a recurring occurrence's event_id changes when its start does.`,
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          required: ['event_id'],
          properties: { event_id: { type: 'string' }, span: SPAN_PROP, ...EVENT_PROPS },
          additionalProperties: false,
        },
        validate: (args) => {
          if (!str(args, 'event_id')) return 'event_id is required (from calendar.events.list)'
          if (args.span !== undefined && !['this', 'future'].includes(str(args, 'span'))) return 'span must be "this" or "future"'
          const keys = ['title', 'start', 'end', 'all_day', 'calendar', 'location', 'notes', 'url', 'alarms_minutes_before', 'recurrence']
          if (!keys.some((k) => args[k] !== undefined)) return `nothing to change: pass at least one of ${keys.join(', ')}`
          if (args.title !== undefined && !str(args, 'title')) return 'title cannot be empty'
          return eventFieldsProblem(args, false)
        },
        async run(args, ctx) {
          ctx.note('正在改日程…')
          return ok(await helper(ctx, 'calendar.events.update', defined({
            event_id: str(args, 'event_id'),
            span: str(args, 'span') || undefined,
            ...eventFields(args, false),
          })))
        },
      },
      {
        name: 'calendar.events.delete',
        group: 'calendar',
        title: '删日程',
        titleEn: 'Delete event',
        description: 'Delete an event by event_id (from calendar.events.list / get); recurring events need span "this" (only this occurrence) or "future" (this and all later ones). The person is always asked first: without confirmed: true nothing is deleted and it returns needs_confirmation naming the event and its time — ask them, and only if they agree call again with the same args plus confirmed: true. Deleting a meeting with attendees may notify them.',
        risk: 'high',
        confirm: 'always',
        confirmsItself: true,
        input_schema: {
          type: 'object',
          required: ['event_id'],
          properties: { event_id: { type: 'string' }, span: SPAN_PROP, ...CONFIRMED_PROP },
          additionalProperties: false,
        },
        validate: (args) => {
          if (!str(args, 'event_id')) return 'event_id is required (from calendar.events.list)'
          if (args.span !== undefined && !['this', 'future'].includes(str(args, 'span'))) return 'span must be "this" or "future"'
          return null
        },
        async run(args, ctx) {
          const id = str(args, 'event_id')
          const span = str(args, 'span') || undefined
          if (args[DEVICE_ACTION_CONFIRMED_ARG] !== true) {
            const event = await helper<EventRow>(ctx, 'calendar.events.get', { event_id: id })
            if (event.recurring && !span) {
              return bad(`"${event.title}" is a recurring event: pass span "this" (only this occurrence) or "future" (this and all later ones), then call again.`)
            }
            return askFirst(ASK_MESSAGE('deleted'), deleteQuestion(event, span, ctx.deps.now()), { event })
          }
          ctx.note('正在删日程…')
          return ok(await helper(ctx, 'calendar.events.delete', defined({ event_id: id, span, confirmed: true })))
        },
      },
      {
        name: 'calendar.events.export',
        group: 'calendar',
        title: '导出日程',
        titleEn: 'Export events (ICS)',
        description: 'Export events as iCalendar (.ics) text: one event by event_id, or every event in a window (start / end / calendar / calendar_ids / query, same rules as calendar.events.list; at least one is required). A recurring event is exported once as its whole series with an RRULE; occurrence_only: true instead exports each selected occurrence as its own one-off event. Includes title, times (UTC; all-day as dates), location, notes, url and alerts; not attendees. At most 500 events / 1 MB (truncated: true when cut). Returns { ics, count, truncated }.',
        risk: 'medium',
        confirm: 'never',
        input_schema: {
          type: 'object',
          properties: {
            event_id: { type: 'string' },
            start: { type: 'string' },
            end: { type: 'string' },
            calendar: { type: 'string', description: 'Calendar name or id' },
            calendar_ids: { type: 'array', items: { type: 'string' } },
            query: { type: 'string' },
            occurrence_only: { type: 'boolean' },
          },
          additionalProperties: false,
        },
        validate: (args) => {
          const start = str(args, 'start')
          const end = str(args, 'end')
          if (!str(args, 'event_id') && !start && !end && !str(args, 'calendar') && args.calendar_ids === undefined) {
            return 'pass event_id, or a window / calendar to export (start, end, calendar, calendar_ids)'
          }
          if (start && !isTime(start)) return `start must be ${TIME_HINT}`
          if (end && !isTime(end)) return `end must be ${TIME_HINT}`
          if (args.calendar_ids !== undefined && !stringList(args.calendar_ids)) return 'calendar_ids must be an array of calendar ids'
          return null
        },
        run: async (args, ctx) => ok(await helper(ctx, 'calendar.events.export', defined({
          event_id: str(args, 'event_id') || undefined,
          start: str(args, 'start') || undefined,
          end: str(args, 'end') || undefined,
          calendar: str(args, 'calendar') || undefined,
          calendar_ids: stringList(args.calendar_ids) ? args.calendar_ids : undefined,
          query: str(args, 'query') || undefined,
          occurrence_only: typeof args.occurrence_only === 'boolean' ? args.occurrence_only : undefined,
        }))),
      },
    ],
  }
}
