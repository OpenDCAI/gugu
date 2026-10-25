import { afterEach, describe, expect, it, vi } from 'vitest'
import { setOwnerTimeZoneContext } from '../../../../apps/desktop/src/session/shared/core/automations/timezone'
import { createActivitySummaryQuery } from '../../../../apps/desktop/electron/activity-summary-query'
import type { ActivityDevice } from '../../../../apps/desktop/electron/activity-device-query'

const at = Date.parse('2026-10-25T04:00:00Z')
afterEach(() => setOwnerTimeZoneContext(null))
const device: ActivityDevice = { device_id: 'cloud', label: '助理', online: true, this_machine: true }
const signal = () => new AbortController().signal
const event = (id: string, session = 's1', time = at - 1_000) => ({ event_id: id, session_id: session,
  kind: 'session.turn_recorded', turn_seq: 1, occurred_at: time, observed_at: time, sequence: time })
function page(events: unknown[], next_cursor: string | null = null) {
  return { events, session_titles: { s1: '真实会话名' }, next_cursor, coverage: { queried_at: at, collector_running: true,
    segments: [{ started_at: at - 600_000, last_seen_at: at, ended_at: null }], untracked: [], note: 'Unknown is not idle.' } }
}
const deps = (query = vi.fn(async (_d: ActivityDevice, _q: Record<string, unknown>, _signal: AbortSignal) => page([event('turn')]))) =>
  ({ scope: 'owner:caller', devices: async () => [device], query })
const run = () => createActivitySummaryQuery({ now: () => at, timeZone: () => 'Asia/Shanghai' })
function sessions(result: Awaited<ReturnType<ReturnType<typeof createActivitySummaryQuery>>>) {
  if (!('sessions' in result)) throw new Error('Expected the summary view')
  return result.sessions
}

describe('activity summaries are complete facts before presentation pagination', () => {
  it('uses the observed owner zone for today and keeps its source attached to the paginated snapshot', async () => {
    const context = { time_zone: 'Pacific/Auckland', source_device_id: 'phone', source_last_seen_at: null,
      read_at: new Date(at).toISOString(), status: 'device' as const }
    setOwnerTimeZoneContext(context)
    const read = createActivitySummaryQuery({ now: () => at })
    const source = deps(vi.fn(async () => page([event('one', 's1'), event('two', 's2')])))
    const first = await read({ action: 'activity_list', limit: 1 }, source, signal())
    expect(first.window).toMatchObject({ time_zone: 'Pacific/Auckland', since: '2026-10-24T11:00:00.000Z', time_zone_source: context })
    setOwnerTimeZoneContext({ ...context, time_zone: 'America/Toronto', source_device_id: 'laptop' })
    const second = await read({ action: 'activity_list', limit: 1, cursor: first.next_cursor }, source, signal())
    expect(second.window).toEqual(first.window)
  })
  it('renders confirmed sleep separately from unknown capture intervals', async () => {
    const since = at - 60_000, until = at - 30_000
    const source = { ...deps(), query: vi.fn(async () => ({ ...page([]), coverage: { ...page([]).coverage,
      segments: [], sleep_intervals: [{ since, until, source: 'native-power' }] } })) }
    const result = await run()({ action: 'activity_list' }, source, signal())
    expect(result.gaps).toContainEqual(expect.objectContaining({ reason: 'sleep', statement: '设备休眠，期间没有任务在运行' }))
    expect(result.gaps).toContainEqual(expect.objectContaining({ reason: 'uncollected', statement: '未采集，不能断定在不在工作' }))
  })
  it.each([
    { name: 'sleep only', segments: [[-150, -90], [-39, 0]], sleep: true,
      summary: '助理：已记录，1 条事件；休眠 1 段共 51 分钟，期间没有任务在运行。' },
    { name: 'uncollected only', segments: [], sleep: false,
      summary: '助理：已记录，1 条事件；未采集 1 段共 2 小时 30 分钟，不能断定在不在工作。' },
    { name: 'sleep and uncollected', segments: [], sleep: true,
      summary: '助理：已记录，1 条事件；休眠 1 段共 51 分钟，期间没有任务在运行；未采集 2 段共 1 小时 39 分钟，不能断定在不在工作。' },
    { name: 'complete coverage', segments: [[-150, 0]], sleep: false,
      summary: '助理：已记录，1 条事件。' },
  ])('summarizes $name without zero-count categories', async ({ segments, sleep, summary }) => {
    const source = { ...deps(), query: vi.fn(async () => ({ ...page([event('turn')]), coverage: { ...page([]).coverage,
      segments: segments.map(([start, end]) => ({ started_at: at + start * 60_000, last_seen_at: at + end * 60_000,
        ended_at: at + end * 60_000 })),
      sleep_intervals: sleep ? [{ since: at - 90 * 60_000, until: at - 39 * 60_000, source: 'fc-confirmed' }] : [],
    } })) }
    const result = await run()({ action: 'activity_list', since: new Date(at - 150 * 60_000).toISOString() }, source, signal())
    expect(result.devices[0].summary).toBe(summary)
    expect(result.note.includes('休眠时段没有任务在运行，不算未采集。')).toBe(sleep)
  })
  it('totals gaps by device and does not round a short unknown interval down to zero', async () => {
    const source = { ...deps(), devices: async () => [device, { ...device, device_id: 'mac', label: 'Mac', this_machine: false }],
      query: vi.fn(async (d: ActivityDevice) => ({ ...page([]), coverage: { ...page([]).coverage,
        segments: [], sleep_intervals: d.this_machine ? [{ since: at - 30_000, until: at, source: 'fc-confirmed' }] : [],
      } })) }
    const result = await run()({ action: 'activity_list', since: new Date(at - 30_000).toISOString() }, source, signal())
    expect(result.devices.map(d => d.summary)).toEqual([
      '助理：已记录，0 条事件；休眠 1 段共 不足 1 分钟，期间没有任务在运行。',
      'Mac：已记录，0 条事件；未采集 1 段共 不足 1 分钟，不能断定在不在工作。',
    ])
  })
  it('defaults to midnight in the declared host zone, reports local bounds and hides raw events', async () => {
    const source = deps()
    const result = await run()({ action: 'activity_list' }, source, signal())
    expect(source.query.mock.calls[0]?.[1]).toMatchObject({ since: '2026-10-24T16:00:00.000Z', until: new Date(at).toISOString() })
    expect(result.header).toContain('2026-10-25 00:00:00 至 2026-10-25 12:00:00（Asia/Shanghai）')
    expect(result).not.toHaveProperty('events')
    expect(sessions(result)).toEqual([expect.objectContaining({ session_name: '真实会话名', recorded_turns: 1,
      last_status: null, first_activity: '2026-10-25 11:59:59' })])
    expect(result.gaps[0]).toMatchObject({ statement: '未采集，不能断定在不在工作', since_local: '2026-10-25 00:00:00' })
  })
  it('uses an explicit IANA zone across a DST change instead of subtracting a fixed offset', async () => {
    const result = await createActivitySummaryQuery({ now: () => Date.parse('2026-11-01T07:00:00Z') })({
      action: 'activity_list', time_zone: 'America/New_York',
    }, deps(), signal())
    expect(result.window.since).toBe('2026-11-01T04:00:00.000Z')
    expect(result.header).toContain('2026-11-01 00:00:00 至 2026-11-01 02:00:00（America/New_York）')
    const source = deps()
    await expect(run()({ action: 'activity_list', time_zone: 'Not/AZone' }, source, signal())).rejects.toThrow()
    expect(source.query).not.toHaveBeenCalled()
  })
  it('reads all source pages and groups a day of events before paging sessions', async () => {
    let clock = at
    const read = createActivitySummaryQuery({ now: () => clock, timeZone: () => 'Asia/Shanghai' })
    const query = vi.fn(async (_d: ActivityDevice, q: Record<string, unknown>) => q.cursor
      ? page([event('later', 's1', at - 1), event('other', 's2', at - 2)])
      : page(Array.from({ length: 120 }, (_, i) => event('event-' + i, 's1', at - 1_000 - i)), 'source-second'))
    const source = { ...deps(), query }
    const first = await read({ action: 'activity_list', limit: 1 }, source, signal())
    expect(sessions(first)[0]).toMatchObject({ session_id: 's1', recorded_turns: 121 })
    expect(first.header).toContain('还有 1 个会话没列出')
    expect(first.remaining).toBe(1)
    clock += 30_000
    const second = await read({ action: 'activity_list', limit: 1, cursor: first.next_cursor }, source, signal())
    expect(sessions(second)[0]).toMatchObject({ session_id: 's2', recorded_turns: 1 })
    expect(second.window).toEqual(first.window) // omitted dates stay bound to the first page
    expect(query).toHaveBeenCalledTimes(2)
    await expect(read({ action: 'activity_list', cursor: first.next_cursor }, { ...source, scope: 'other' }, signal())).rejects.toThrow(/caller/)
    await expect(read({ action: 'activity_list', details: true, cursor: first.next_cursor }, source, signal())).rejects.toThrow(/query/)
  })
  it('shows offline, outdated and timed-out devices with explicit unknown intervals, without losing fast results', async () => {
    const devices = [device, { ...device, device_id: 'offline', online: false, this_machine: false },
      { ...device, device_id: 'old', this_machine: false }, { ...device, device_id: 'slow', this_machine: false }]
    const query = vi.fn(async (d: ActivityDevice) => {
      if (d.device_id === 'old') throw Object.assign(Error('upgrade required'), { code: 'SESSION_DEVICE_OUTDATED' })
      if (d.device_id === 'slow') return new Promise(() => undefined)
      return page([event('fast')])
    })
    const result = await createActivitySummaryQuery({ now: () => at, timeoutMs: 10 })({ action: 'activity_list' }, {
      scope: 'owner', devices: async () => devices, query,
    }, signal())
    expect(result.devices.map(d => [d.device_id, d.status, d.event_count])).toEqual([
      ['cloud', '已记录', 1], ['offline', '离线', 0], ['old', '版本过旧', 0], ['slow', '超时', 0],
    ])
    expect(result.gaps.filter(g => ['offline', 'old', 'slow'].includes(g.device_id))).toHaveLength(3)
    expect(result.gaps.every(g => g.statement === '未采集，不能断定在不在工作')).toBe(true)
    expect(query.mock.calls.map(c => c[0].device_id)).not.toContain('offline')
  })
  it('includes raw events only for an explicit details request or a session filter', async () => {
    for (const selector of [{ details: true }, { session_id: 's1' }]) {
      const result = await run()({ action: 'activity_list', ...selector }, deps(), signal())
      if (!('events' in result)) throw new Error('Expected the details view')
      expect(result.events).toHaveLength(1)
      expect(result).not.toHaveProperty('sessions')
      expect(result.events?.[0]).toMatchObject({ event_id: 'turn', session_id: 's1' })
    }
  })
  it('distinguishes observation time, a recorded turn end, and missing historical status', async () => {
    const result = await run()({ action: 'activity_list' }, deps(vi.fn(async () => page([
      { ...event('unknown'), kind: 'session.created', occurred_at: null },
      { ...event('state', 's1', at - 500), kind: 'agent.status', status: 'idle', detail: 'done' },
    ]))), signal())
    expect(sessions(result)[0]).toMatchObject({ first_time_basis: 'observed', recorded_turns: 0, last_status: 'idle', last_detail: 'done' })
    expect(sessions(result)[0].status_note).toContain('轮次结束不等于验收')
  })
})
