import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const calls: { route: string; input: unknown }[] = []
  const route = (name: string) => vi.fn((input: unknown) => { calls.push({ route: name, input }); return Promise.resolve({ ok: true, value: { route: name } }) })
  const sessionTimeline = Object.fromEntries(
    ['sessionSnapshot', 'sessionAfter', 'sessionOlder', 'sessionSubscribe', 'sessionBackgroundTasks', 'sessionStopBackgroundTask'].map((n) => [n, route(n)]),
  )
  return { calls, sessionTimeline }
})
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: mocks.sessionTimeline }), events: { on: () => () => undefined } }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ fetchSnapshot: vi.fn() }))
vi.mock('../../../../apps/desktop/src/session/shared/core/session-timeline/sessionTimelineEvents', () => ({ sessionpageSessionTimelineChannel: { name: 'x' } }))

import { assistantTimelineClient } from '../../../../apps/desktop/src/components/assistant/assistantTimelineClient'

beforeEach(() => { mocks.calls.length = 0 })

it('reads a local session whole when asked (trim:false), so a long message_send reply survives', async () => {
  const client = assistantTimelineClient(true, { trim: false })
  await client.fetchSnapshot('d', 's')
  await client.fetchAfter('d', 's', {} as never)
  await client.fetchOlder('d', 's', 't1')
  await client.subscribeSession('d', 's', 'sub', null)
  expect(mocks.calls.map((c) => (c.input as { trim: boolean }).trim)).toEqual([false, false, false, false])
  expect(assistantTimelineClient(true, { trim: false })).toBe(client)
})

it('keeps trimming by default', async () => {
  await assistantTimelineClient(true).fetchSnapshot('d', 's')
  expect((mocks.calls[0]!.input as { trim: boolean }).trim).toBe(true)
})

it('asks this computer which background commands still run, and stops one', async () => {
  const client = assistantTimelineClient(true)
  await client.fetchBackgroundTasks!('d', 's')
  await client.stopBackgroundTask!('d', 's', 'b1')
  expect(mocks.calls).toEqual([
    { route: 'sessionBackgroundTasks', input: { conversationId: 's' } },
    { route: 'sessionStopBackgroundTask', input: { conversationId: 's', stopId: 'b1' } },
  ])
})
