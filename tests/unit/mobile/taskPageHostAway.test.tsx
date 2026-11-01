// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import {
  useTimelineSession,
  type AgentWatchSession,
  type SessionpageTimelineClient,
} from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import { clearTimelineCache, forgetInMemoryTimelines } from '../../../apps/desktop/src/mobile/agent-watch/timeline-cache'
import { createNode, createReactHarness } from '../../support/testHarness'

/**
 * A phone opens a task whose machine is away. Two shapes: the directory still says online (a crashed or cut-off
 * machine keeps its lease for minutes) and nothing answers; or the directory already says offline.
 */
const SNAPSHOT: TimelineSnapshot = {
  cursor: { epoch: 'e1', seq: 10 },
  turns: [{ id: 'a', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'a-m', seq: 0, role: 'user', text: 'itinerary' }] }],
  settlements: [],
  hasOlder: false,
}

function fakeClient() {
  const hooks = { link: null as null | ((open: boolean) => void) }
  const client = {
    fetchSnapshot: vi.fn(async () => SNAPSHOT),
    fetchAfter: vi.fn(),
    fetchOlder: vi.fn(),
    subscribeSession: vi.fn(async () => ({})),
    unsubscribeSession: vi.fn(async () => ({})),
    subscribeSessionEvents: vi.fn(() => () => undefined),
    onLinkChange: vi.fn((_d: string, cb: (open: boolean) => void) => {
      hooks.link = cb
      return () => undefined
    }),
    sendSessionText: vi.fn(),
    cancelSessionTurn: vi.fn(),
    respondToSettlement: vi.fn(),
  }
  return { client: client as unknown as SessionpageTimelineClient, fetchSnapshot: client.fetchSnapshot, hooks }
}

let session: AgentWatchSession
function Probe({ client, enabled }: { client: SessionpageTimelineClient; enabled: boolean }) {
  session = useTimelineSession(client, 'phone', 'machine-1', 'conversation-1', enabled)
  return null
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await clearTimelineCache()
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.useRealTimers()
})

const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('task page, machine away', () => {
  it('no answer to the open: says the link is lost at once instead of waiting it out, and comes back by itself', async () => {
    vi.useFakeTimers()
    const f = fakeClient()
    f.fetchSnapshot.mockRejectedValueOnce(Object.assign(new Error('Cannot reach the task host'), { code: 'timeout' }))
    await harness.render(createNode(Probe, { client: f.client, enabled: true }))
    await advance(10_000)
    expect(session.link).toBe('lost')
    expect(session.errorCode).toBe('timeout')
    expect(f.fetchSnapshot, 'a machine that did not answer is not asked again as if it were a hiccup').toHaveBeenCalledTimes(1)
    await act(async () => { f.hooks.link?.(true) })
    await advance(500)
    expect(session.phase).toBe('ready')
    expect(session.link).toBe('ok')
    expect(session.timeline.turns).toHaveLength(1)
  })

  it('offline in the directory: what this phone saw last time is still drawn, without asking the machine', async () => {
    vi.useFakeTimers()
    const seen = fakeClient()
    await harness.render(createNode(Probe, { client: seen.client, enabled: true }))
    await advance(500)
    expect(session.timeline.turns).toHaveLength(1)
    harness.cleanup()
    // A cold start: only the on-device copy is left.
    forgetInMemoryTimelines()
    vi.useRealTimers()

    harness = createReactHarness()
    const away = fakeClient()
    await harness.render(createNode(Probe, { client: away.client, enabled: false }))
    await vi.waitFor(() => expect(session.timeline.turns).toHaveLength(1))
    expect(session.link).toBe('lost')
    expect(away.fetchSnapshot).not.toHaveBeenCalled()
  })
})
