import { randomUUID } from 'node:crypto'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { z } from 'zod'
import { activityEventSchema, activityQuerySchema, type ActivityQuery } from '@shared/core/activity'

export type ActivityDevice = { device_id: string; label: string | null; online: boolean; this_machine: boolean }
type QueryDeps = {
  scope: string
  devices(): Promise<ActivityDevice[]>
  query(device: ActivityDevice, query: ActivityQuery, signal: AbortSignal): Promise<unknown>
}
const pageSchema = z.object({
  events: z.array(activityEventSchema.extend({ sequence: z.number().int().nonnegative() })).max(200),
  next_cursor: z.string().nullable(),
  coverage: z.object({
    queried_at: z.number(), collector_running: z.boolean(),
    segments: z.array(z.object({ started_at: z.number(), last_seen_at: z.number(), ended_at: z.number().nullable() })),
    untracked: z.array(z.string()), note: z.string(),
  }),
})
type Page = z.infer<typeof pageSchema>
type DeviceResult = { device: ActivityDevice; events: Page['events']; coverage?: Page['coverage'];
  status: 'recorded' | 'offline' | 'timeout' | 'error'; error?: { code: string; message: string } }
type Gap = { device_id: string; device_label: string | null; since: string; until: string;
  reason: 'uncollected' | 'offline' | 'timeout' }
type Snapshot = { scope: string; signature: string; devices: string[]; expires: number;
  events: Array<Page['events'][number] & { device_id: string; device_label: string | null }>;
  coverage: { scope: 'account_devices'; queried_at: number; note: string; devices: Array<Record<string, unknown>>; gaps: Gap[] } }

/** Coverage is attested only through the collector's last heartbeat, never through an inferred online interval. */
function gapsFor(result: DeviceResult, since: number, until: number): Gap[] {
  const gap = (start: number, end: number, reason: Gap['reason']): Gap => ({
    device_id: result.device.device_id, device_label: result.device.label,
    since: new Date(start).toISOString(), until: new Date(end).toISOString(), reason,
  })
  if (result.status !== 'recorded') return [gap(since, until,
    result.status === 'offline' || result.status === 'timeout' ? result.status : 'uncollected')]
  const segments = result.coverage!.segments.map(s => [Math.max(since, s.started_at), Math.min(until, s.ended_at ?? s.last_seen_at)])
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0])
  const gaps: Gap[] = []
  let at = since
  for (const [start, end] of segments) {
    if (start > at) gaps.push(gap(at, start, 'uncollected'))
    at = Math.max(at, end)
  }
  if (at < until) gaps.push(gap(at, until, 'uncollected'))
  return gaps
}

/**
 * Read all metadata pages under one deadline per device before sorting. Journals page by observation sequence,
 * so merging just their first pages would lose chronological order and skip late-observed events. A short-lived,
 * caller-bound snapshot pages the resulting timeline without rereading devices or hiding truncated results.
 * Expired/evicted cursors fail explicitly; the underlying journals remain the durable source of truth.
 */
export function createActivityDeviceQuery(options: { timeoutMs?: number; now?: () => number; snapshotTtlMs?: number } = {}) {
  const now = options.now ?? Date.now
  const snapshots = new Map<string, Snapshot>()
  const timeoutMs = options.timeoutMs ?? 5_000
  const ttl = options.snapshotTtlMs ?? 300_000

  async function readDevice(device: ActivityDevice, query: ActivityQuery, deps: QueryDeps, signal: AbortSignal): Promise<DeviceResult> {
    signal.throwIfAborted()
    if (!device.this_machine && !device.online) return { device, events: [], status: 'offline' }
    const controller = new AbortController()
    let abort: () => void
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => { controller.abort(signal.reason); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
    })
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const read = async (): Promise<DeviceResult> => {
        const events: Page['events'] = []
        let cursor: string | undefined
        let coverage: Page['coverage'] | undefined
        const seen = new Set<string>()
        do {
          controller.signal.throwIfAborted()
          const page = pageSchema.parse(await deps.query(device, { ...query, limit: 200, ...(cursor ? { cursor } : {}) }, controller.signal))
          events.push(...page.events)
          coverage ??= page.coverage
          if (page.next_cursor && seen.has(page.next_cursor)) throw new Error('Activity source repeated its cursor')
          if (page.next_cursor) seen.add(page.next_cursor)
          cursor = page.next_cursor ?? undefined
          // Local SQLite pages can resolve synchronously; let deadlines/cancellation run between pages too.
          if (cursor) await yieldToLoop(undefined, { signal: controller.signal })
        } while (cursor)
        return { device, events, coverage, status: 'recorded' }
      }
      const deadline = new Promise<DeviceResult>(resolve => {
        timer = setTimeout(() => {
          // Resolve first: a transport ignoring cancellation must not hold other devices' results hostage.
          resolve({ device, events: [], status: 'timeout' })
          controller.abort(new Error('Activity device query timed out'))
        }, timeoutMs)
      })
      return await Promise.race([read(), deadline, cancelled])
    } catch (error) {
      signal.throwIfAborted()
      return { device, events: [], status: 'error', error: {
        code: typeof (error as { code?: unknown })?.code === 'string' ? (error as { code: string }).code : 'activity_source_error',
        message: error instanceof Error ? error.message : String(error),
      } }
    } finally {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort!)
    }
  }

  return async (action: Record<string, unknown>, deps: QueryDeps, signal: AbortSignal) => {
    signal.throwIfAborted()
    const { action: _, device, ...input } = action
    const q = activityQuerySchema.parse(input)
    const { cursor, limit, ...query } = q
    const available = await deps.devices()
    const devices = typeof device === 'string' ? available.filter(d => d.device_id === device) : available
    if (typeof device === 'string' && devices.length !== 1) throw new Error('Activity device is not an owned task host; use session_devices')
    const signature = JSON.stringify([device ?? null, query])
    for (const [id, snapshot] of snapshots) if (snapshot.expires <= now()) snapshots.delete(id)
    let id: string
    let offset = 0
    let snapshot: Snapshot
    if (cursor) {
      let decoded: unknown
      try { decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString()) } catch { throw new Error('Invalid activity cursor') }
      const parsed = z.object({ id: z.string().uuid(), offset: z.number().int().positive() }).strict().parse(decoded)
      id = parsed.id
      const held = snapshots.get(id)
      if (!held || held.scope !== deps.scope || held.signature !== signature
        || JSON.stringify(held.devices) !== JSON.stringify(devices.map(d => d.device_id).sort())) {
        throw new Error('Activity cursor expired or does not match this caller, device set or query; start a new query')
      }
      snapshot = held
      offset = parsed.offset
      if (offset >= snapshot.events.length) throw new Error('Activity cursor is outside the snapshot')
    } else {
      const results = await Promise.all(devices.map(d => readDevice(d, query, deps, signal)))
      signal.throwIfAborted()
      const since = Date.parse(q.since), until = Date.parse(q.until)
      snapshot = { scope: deps.scope, signature, devices: devices.map(d => d.device_id).sort(), expires: now() + ttl,
        events: results.flatMap(r => r.events.map(event => ({ ...event, device_id: r.device.device_id, device_label: r.device.label })))
          .sort((a, b) => (a.occurred_at ?? a.observed_at) - (b.occurred_at ?? b.observed_at)
            || a.device_id.localeCompare(b.device_id) || a.sequence - b.sequence),
        coverage: { scope: 'account_devices', queried_at: now(),
          note: 'Gaps describe unavailable records, not measured offline durations. A turn ending is not task acceptance; use activity_context on the event device to read sources.',
          devices: results.map(r => ({ device_id: r.device.device_id, device_label: r.device.label,
            online: r.device.online, this_machine: r.device.this_machine,
            query_status: r.status, ...(r.coverage ? { ...r.coverage } : {}), ...(r.error ? { error: r.error } : {}) })),
          gaps: results.flatMap(r => gapsFor(r, since, until)) } }
      id = randomUUID()
      // Bound cached queries, not the result: callers can always start a fresh query after eviction.
      if (snapshots.size >= 32) snapshots.delete(snapshots.keys().next().value!)
      if (snapshot.events.length > limit) snapshots.set(id, snapshot)
    }
    return { events: snapshot.events.slice(offset, offset + limit), order: 'event_time_then_device_sequence',
      next_cursor: offset + limit < snapshot.events.length
        ? Buffer.from(JSON.stringify({ id, offset: offset + limit })).toString('base64url') : null,
      coverage: snapshot.coverage }
  }
}
