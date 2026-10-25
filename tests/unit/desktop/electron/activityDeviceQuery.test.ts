import { afterEach, describe, expect, it, vi } from 'vitest'
import { createActivityDeviceQuery, type ActivityDevice } from '../../../../apps/desktop/electron/activity-device-query'

const since = '2026-10-25T00:00:00Z', until = '2026-10-25T01:00:00Z'
const start = Date.parse(since), end = Date.parse(until)
const devices: ActivityDevice[] = [
  { device_id: 'cloud', label: 'Cloud', online: true, this_machine: true },
  { device_id: 'mac', label: 'Mac', online: true, this_machine: false },
  { device_id: 'phone', label: 'Phone', online: false, this_machine: false },
]
const action = { action: 'activity_list', since, until }
const event = (id: string, time: number, observed = time) => ({ event_id: id, kind: 'session.created',
  occurred_at: time, observed_at: observed, sequence: observed, session_id: 's' })
const segment = (from: number, to: number) => ({ started_at: from, last_seen_at: to, ended_at: to })
function page(events: unknown[] = [], segments = [segment(start, end)], next_cursor: string | null = null) {
  return { events, next_cursor, coverage: { queried_at: end, collector_running: true, segments,
    untracked: ['external_cli_without_adapter'], note: 'Unknown gaps are not inactivity.' } }
}
const signal = () => new AbortController().signal
const deps = (query: (device: ActivityDevice, q: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>) =>
  ({ scope: 'owner:caller', devices: async () => devices, query })
afterEach(() => vi.useRealTimers())

describe('device activity aggregation on the Agent control path', () => {
  it('separates confirmed device sleep from an unknown awake capture gap', async () => {
    const source = { ...deps(async () => ({ ...page([], []), coverage: { ...page([], []).coverage,
      sleep_intervals: [{ since: start + 1000, until: end - 1000, source: 'fc-confirmed' }] } })),
      devices: async () => [devices[0]] }
    const result = await createActivityDeviceQuery()(action, source, signal())
    expect(result.coverage.gaps.map(gap => gap.reason)).toEqual(['uncollected', 'sleep', 'uncollected'])
    const unknown = await createActivityDeviceQuery()(action, { ...source, query: async () => page([], []) }, signal())
    expect(unknown.coverage.gaps.map(gap => gap.reason)).toEqual(['uncollected'])
  })
  it('uses current published titles for old hosts, while an authoritative empty title set removes stale names', async () => {
    const source = { ...deps(async () => page([event('metadata', start + 1)])),
      devices: async () => [{ ...devices[0], session_titles: { s: 'Published name' } }] }
    const first = await createActivityDeviceQuery()(action, source, signal())
    expect(first.session_titles.cloud).toEqual({ s: 'Published name' })
    const missing = await createActivityDeviceQuery()(action, { ...source,
      query: async () => ({ ...page([event('deleted', start + 1)]), session_titles: {} }) }, signal())
    expect(missing.session_titles.cloud).toEqual({})
  })
  it('queries all task hosts, labels and sorts events, and explicitly includes offline devices in gaps', async () => {
    const query = vi.fn(async (d: ActivityDevice) => d.device_id === 'cloud'
      ? page([event('cloud-event', start + 20)]) : page([event('mac-event', start + 10)]))
    const result = await createActivityDeviceQuery()(action, deps(query), signal())
    expect(query.mock.calls.map(([d]) => d.device_id)).toEqual(['cloud', 'mac'])
    expect(result.events.map(e => [e.event_id, e.device_id, e.device_label])).toEqual([
      ['mac-event', 'mac', 'Mac'], ['cloud-event', 'cloud', 'Cloud'],
    ])
    expect(result.coverage.gaps).toEqual([{ device_id: 'phone', device_label: 'Phone', since: new Date(start).toISOString(),
      until: new Date(end).toISOString(), reason: 'offline' }])
    expect(result.coverage.devices).toContainEqual(expect.objectContaining({ device_id: 'phone', query_status: 'offline' }))
  })
  it('does not query or wake other devices when an explicit device is selected', async () => {
    const query = vi.fn(async (_d: ActivityDevice, _q: Record<string, unknown>, _signal: AbortSignal) => page())
    const result = await createActivityDeviceQuery()({ ...action, device: 'mac' }, deps(query), signal())
    expect(query).toHaveBeenCalledOnce()
    expect(query.mock.calls[0]?.[0]).toMatchObject({ device_id: 'mac' })
    expect(result.coverage.devices).toHaveLength(1)
    await expect(createActivityDeviceQuery()({ ...action, device: 'stranger' }, deps(query), signal())).rejects.toThrow(/owned task host/)
  })
  it('bounds the entire device read, even when its transport ignores cancellation, and preserves fast results', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async (d: ActivityDevice, _q: Record<string, unknown>, _signal: AbortSignal) => d.device_id === 'mac'
      ? new Promise(() => undefined) : page([event('fast', start + 1)]))
    const pending = createActivityDeviceQuery({ timeoutMs: 100 })(action, deps(query), signal())
    await vi.advanceTimersByTimeAsync(99)
    expect(query).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(1)
    const result = await pending
    expect(result.events.map(e => e.event_id)).toEqual(['fast'])
    expect(result.coverage.gaps).toContainEqual(expect.objectContaining({ device_id: 'mac', reason: 'timeout',
      since: new Date(start).toISOString(), until: new Date(end).toISOString() }))
    expect(query.mock.calls.find(([d]) => d.device_id === 'mac')?.[2]?.aborted).toBe(true)
  })
  it('lets deadlines run while a local source keeps returning immediately resolved pages', async () => {
    let next = 0
    const query = async () => page([], undefined, `more-${++next}`)
    const result = await createActivityDeviceQuery({ timeoutMs: 20 })({ ...action, device: 'cloud' }, deps(query), signal())
    expect(result.coverage.devices).toContainEqual(expect.objectContaining({ device_id: 'cloud', query_status: 'timeout' }))
    expect(result.coverage.gaps).toContainEqual(expect.objectContaining({ device_id: 'cloud', reason: 'timeout' }))
  })
  it('calculates half-open gaps from clipped, overlapping coverage instead of asking the model to infer them', async () => {
    const query = async () => page([], [segment(start - 50, start + 10), segment(start + 5, start + 20),
      segment(start + 30, start + 40), segment(end, end + 10)])
    const result = await createActivityDeviceQuery()({ ...action, device: 'cloud' }, deps(query), signal())
    expect(result.coverage.gaps.map(g => [Date.parse(g.since) - start, Date.parse(g.until) - start, g.reason]))
      .toEqual([[20, 30, 'uncollected'], [40, end - start, 'uncollected']])
  })
  it('keeps unknown source time null and uses observation time only for sorting', async () => {
    const query = async () => page([{ ...event('unknown', start + 10), occurred_at: null }, event('known', start + 5)])
    const result = await createActivityDeviceQuery()({ ...action, device: 'cloud' }, deps(query), signal())
    expect(result.events.map(e => [e.event_id, e.occurred_at])).toEqual([['known', start + 5], ['unknown', null]])
  })
  it('reads every source page before merging late-observed events, then pages a fixed caller-bound snapshot', async () => {
    const query = vi.fn(async (d: ActivityDevice, q: Record<string, unknown>) => d.device_id === 'mac'
      ? page([event('middle', start + 20)])
      : q.cursor ? page([event('late-observed', start + 10, start + 50)])
        : page([event('last', start + 30)], undefined, 'source-page-2'))
    const run = createActivityDeviceQuery()
    const first = await run({ ...action, limit: 1 }, deps(query), signal())
    expect(first.events.map(e => e.event_id)).toEqual(['late-observed'])
    expect(query).toHaveBeenCalledTimes(3)
    const second = await run({ ...action, limit: 1, cursor: first.next_cursor }, deps(query), signal())
    const third = await run({ ...action, limit: 1, cursor: second.next_cursor }, deps(query), signal())
    expect(second.events.map(e => e.event_id)).toEqual(['middle'])
    expect(third.events.map(e => e.event_id)).toEqual(['last'])
    expect(third.next_cursor).toBeNull()
    expect(query).toHaveBeenCalledTimes(3)
    for (const changed of [{ scope: 'owner:other' }, { devices: async () => devices.slice(0, 1) }]) {
      await expect(run({ ...action, cursor: first.next_cursor }, { ...deps(query), ...changed }, signal())).rejects.toThrow(/caller, device set or query/)
    }
    await expect(run({ ...action, until: '2026-10-25T02:00:00Z', cursor: first.next_cursor }, deps(query), signal())).rejects.toThrow(/query/)
  })
  it('reports expiry explicitly instead of silently starting a different timeline', async () => {
    let now = 0
    const run = createActivityDeviceQuery({ now: () => now, snapshotTtlMs: 100 })
    const query = async () => page([event('a', start), event('b', start + 1)])
    const first = await run({ ...action, limit: 1, device: 'cloud' }, deps(query), signal())
    now = 101
    await expect(run({ ...action, limit: 1, device: 'cloud', cursor: first.next_cursor }, deps(query), signal())).rejects.toThrow(/expired/)
  })
  it('exposes failed and malformed sources as errors with an uncollected interval, not successful empty history', async () => {
    const query = async (d: ActivityDevice) => {
      if (d.device_id === 'mac') throw Object.assign(new Error('Denied by owner scope'), { code: 'forbidden' })
      return { events: [], next_cursor: null, coverage: {} }
    }
    const result = await createActivityDeviceQuery()(action, deps(query), signal())
    expect(result.coverage.devices).toContainEqual(expect.objectContaining({ device_id: 'mac', query_status: 'error',
      error: { code: 'forbidden', message: 'Denied by owner scope' } }))
    expect(result.coverage.devices).toContainEqual(expect.objectContaining({ device_id: 'cloud', query_status: 'error' }))
    expect(result.coverage.gaps).toHaveLength(3)
  })

  it('cancels an in-flight query promptly even when the remote transport ignores abort', async () => {
    vi.useFakeTimers()
    const query = vi.fn(async () => new Promise(() => undefined))
    const controller = new AbortController()
    const pending = createActivityDeviceQuery()(action, deps(query), controller.signal)
    const rejection = expect(pending).rejects.toThrow('owner cancelled')
    await vi.advanceTimersByTimeAsync(1)
    controller.abort(new Error('owner cancelled'))
    await rejection
    expect(vi.getTimerCount()).toBe(0)
  })
  it('rejects invalid queries before any device access and never swallows caller cancellation', async () => {
    const query = vi.fn(async (_d: ActivityDevice, _q: Record<string, unknown>, _signal: AbortSignal) => page())
    const run = createActivityDeviceQuery()
    await expect(run({ ...action, until: since }, deps(query), signal())).rejects.toThrow(/until/)
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await expect(run(action, deps(query), controller.signal)).rejects.toThrow(/caller cancelled/)
    expect(query).not.toHaveBeenCalled()
  })
})
