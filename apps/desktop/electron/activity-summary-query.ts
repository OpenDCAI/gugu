import { randomUUID } from 'node:crypto'
import { Cron } from 'croner'
import { z } from 'zod'
import { activityQuerySchema } from '@shared/core/activity'
import { getLocalTimeZone } from '@shared/core/automations/timezone'
import { createActivityDeviceQuery, type ActivityQueryDeps } from './activity-device-query'

const inputSchema = z.object({
  since: z.string().datetime({ offset: true }).optional(), until: z.string().datetime({ offset: true }).optional(),
  time_zone: z.string().min(1).optional(), details: z.boolean().optional(),
  session_id: z.string().min(1).max(512).optional(), project_id: z.string().min(1).max(512).optional(),
  limit: z.number().int().min(1).max(200).optional(), cursor: z.string().max(4096).optional(),
}).strict()
type Timeline = Awaited<ReturnType<ReturnType<typeof createActivityDeviceQuery>>>
type Event = Timeline['events'][number]
type Summary = { device_id: string; device_label: string | null; session_id: string; session_name: string | null;
  first_activity: string; last_activity: string; first_time_basis: 'event' | 'observed'; last_time_basis: 'event' | 'observed';
  recorded_turns: number; event_count: number; last_status: string | null; last_detail: string | null;
  status_note: string; event_id: string }
type Held = { scope: string; signature: string; deviceSet: string; expires: number; timeline: Timeline; summaries: Summary[];
  since: string; until: string; zone: string; detail: boolean }
const UNKNOWN = '未采集，不能断定在不在工作'

function clock(at: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at)
  const p = (type: Intl.DateTimeFormatPartTypes) => parts.find(part => part.type === type)!.value
  return `${p('year')}-${p('month')}-${p('day')} ${p('hour')}:${p('minute')}:${p('second')}`
}
function today(at: number, zone: string): string {
  const day = clock(at, zone).slice(0, 10)
  const midnight = new Cron(`${day}T00:00:00`, { timezone: zone }).nextRun(new Date(0))
  if (!midnight) throw new Error('Cannot resolve the start of today in this time zone')
  return midnight.toISOString()
}
function summaries(timeline: Timeline, zone: string): Summary[] {
  const groups = new Map<string, Event[]>()
  for (const event of timeline.events) {
    if (!event.session_id) continue
    const key = JSON.stringify([event.device_id, event.session_id])
    const group = groups.get(key) ?? []
    group.push(event); groups.set(key, group)
  }
  return [...groups.values()].map(events => {
    const first = events[0], last = events.at(-1)!
    const status = events.findLast(event => event.status !== undefined || event.lifecycle !== undefined)
    const source = events.findLast(event => event.kind === 'session.turn_recorded') ?? last
    return { device_id: first.device_id, device_label: first.device_label, session_id: first.session_id!,
      session_name: timeline.session_titles[first.device_id]?.[first.session_id!] ?? null,
      first_activity: clock(first.occurred_at ?? first.observed_at, zone), last_activity: clock(last.occurred_at ?? last.observed_at, zone),
      first_time_basis: first.occurred_at === null ? 'observed' as const : 'event' as const,
      last_time_basis: last.occurred_at === null ? 'observed' as const : 'event' as const,
      recorded_turns: events.filter(event => event.kind === 'session.turn_recorded').length, event_count: events.length,
      last_status: status?.status ?? status?.lifecycle ?? null, last_detail: status?.detail ?? null,
      status_note: '最后状态取自查询窗内的记录；轮次结束不等于验收。名称来自设备最近元数据；来源事件可按需回读。', event_id: source.event_id }
  })
}

/** A complete metadata read precedes session pagination. Raw events are opt-in;
 * coverage gaps and device failures remain visible on every summary page. */
export function createActivitySummaryQuery(options: { now?: () => number; timeZone?: () => string; timeoutMs?: number } = {}) {
  const now = options.now ?? Date.now
  const read = createActivityDeviceQuery(options)
  const held = new Map<string, Held>()
  return async (action: Record<string, unknown>, deps: ActivityQueryDeps, signal: AbortSignal) => {
    signal.throwIfAborted()
    const { action: _, device, ...input } = action
    const q = inputSchema.parse(input)
    const zone = q.time_zone ?? options.timeZone?.() ?? getLocalTimeZone()
    new Intl.DateTimeFormat('en-US', { timeZone: zone }) // invalid zones fail before any device access
    const available = await deps.devices()
    const deviceSet = JSON.stringify(available.map(d => d.device_id).sort())
    const { cursor, limit } = q
    const signature = (since: string, until: string, timeZone: string) => JSON.stringify([
      device ?? null, since, until, q.session_id ?? null, q.project_id ?? null, q.details === true || !!q.session_id, timeZone,
    ])
    for (const [id, value] of held) if (value.expires <= now()) held.delete(id)
    let id: string, offset = 0, snapshot: Held
    if (cursor) {
      let decoded: unknown
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { throw new Error('Invalid activity cursor') }
      const c = z.object({ id: z.string().uuid(), offset: z.number().int().positive() }).strict().parse(decoded)
      id = c.id; offset = c.offset
      const previous = held.get(id)
      if (!previous || previous.scope !== deps.scope || previous.deviceSet !== deviceSet
        || previous.signature !== signature(q.since ?? previous.since, q.until ?? previous.until, q.time_zone ?? previous.zone)) {
        throw new Error('Activity cursor expired or does not match this caller, device set or query; start a new query')
      }
      snapshot = previous
    } else {
      const at = now()
      const query = activityQuerySchema.parse({ session_id: q.session_id, project_id: q.project_id,
        since: q.since ?? today(at, zone), until: q.until ?? new Date(at).toISOString(), limit: 200 })
      // Only the journal's query keys cross to a device. Presentation is local.
      const native = { since: query.since, until: query.until, session_id: query.session_id, project_id: query.project_id, limit: 200 }
      const scoped = { ...deps, devices: async () => available }
      const timeline = await read({ action: 'activity_list', device, ...native }, scoped, signal)
      let next = timeline.next_cursor
      while (next) {
        signal.throwIfAborted()
        const page = await read({ action: 'activity_list', device, ...native, cursor: next }, scoped, signal)
        timeline.events.push(...page.events); next = page.next_cursor
      }
      snapshot = { scope: deps.scope, signature: signature(query.since, query.until, zone), deviceSet, expires: now() + 300_000, timeline,
        summaries: summaries(timeline, zone), since: query.since, until: query.until, zone, detail: q.details === true || !!q.session_id }
      id = randomUUID()
    }
    const size = limit ?? (snapshot.detail ? 50 : 200)
    const total = snapshot.detail ? snapshot.timeline.events.length : snapshot.summaries.length
    if (offset > 0 && offset >= total) throw new Error('Activity cursor is outside the snapshot')
    const remaining = Math.max(0, total - offset - size)
    const devices = snapshot.timeline.coverage.devices.map(device => {
      const count = snapshot.timeline.events.filter(event => event.device_id === device.device_id).length
      const error = device.error as { code?: string; message?: string } | undefined
      const status = device.query_status === 'recorded' ? '已记录' : device.query_status === 'offline' ? '离线'
        : device.query_status === 'timeout' ? '超时' : error?.code === 'SESSION_DEVICE_OUTDATED' ? '版本过旧' : '读取失败'
      return { device_id: device.device_id, device_label: device.device_label, status, event_count: count,
        summary: `${device.device_label ?? device.device_id}：${status}，${count} 条事件。${status === '已记录' ? '采集缺口见下。' : UNKNOWN}`,
        ...(error ? { error } : {}) }
    })
    const gaps = snapshot.timeline.coverage.gaps.map(gap => ({ ...gap,
      since_local: clock(Date.parse(gap.since), snapshot.zone), until_local: clock(Date.parse(gap.until), snapshot.zone), statement: UNKNOWN }))
    const next = remaining > 0 ? Buffer.from(JSON.stringify({ id, offset: offset + size })).toString('base64url') : null
    if (next) {
      if (!held.has(id) && held.size >= 32) held.delete(held.keys().next().value!)
      held.set(id, snapshot)
    }
    return { header: `查询时间窗：${clock(Date.parse(snapshot.since), snapshot.zone)} 至 ${clock(Date.parse(snapshot.until), snapshot.zone)}（${snapshot.zone}）。`
      + (remaining ? `还有 ${remaining} 个${snapshot.detail ? '事件' : '会话'}没列出，见 next_cursor。` : '全部列出。'),
      window: { since: snapshot.since, until: snapshot.until, time_zone: snapshot.zone }, devices,
      ...(snapshot.detail ? { events: snapshot.timeline.events.slice(offset, offset + size) } : { sessions: snapshot.summaries.slice(offset, offset + size) }),
      gaps, remaining, next_cursor: next, note: '未采集，不能断定在不在工作。轮次结束不等于验收；任务内容须按来源核对。' }
  }
}
