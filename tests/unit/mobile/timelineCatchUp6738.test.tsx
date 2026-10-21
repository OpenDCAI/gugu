// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  TimelineAfterResult,
  TimelineSnapshot,
} from '@gugu/session-core/session-record/contract'
import {
  useTimelineSession,
  type AgentWatchSession,
  type SessionpageTimelineClient,
} from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import { clearTimelineCache } from '../../../apps/desktop/src/mobile/agent-watch/timeline-cache'
import { createNode, createReactHarness } from '../../support/testHarness'

/**
 * #6738 第三张图:手机回前台后补缺口(`after`)超时一次,页面就一直挂着「打不开时间线 · 重新读取」,
 * 而时间线好端端在屏幕上。补缺口与首读同一个判据:会自己好的按退避自己再补,退避走完或机器明确拒绝才报原文;
 * 报了之后再补上就收回。
 */
const SNAPSHOT: TimelineSnapshot = {
  cursor: { epoch: 'e1', seq: 10 },
  turns: [{ id: 'a', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'a-m', seq: 0, role: 'user', text: '行程单' }] }],
  settlements: [],
  hasOlder: false,
}
const caughtUp = (seq: number): TimelineAfterResult => ({
  ok: true,
  batch: { from: 10, cursor: { epoch: 'e1', seq }, turns: [], removedTurnIds: [], settlements: [] },
})
const timedOut = () => new Error('Device RPC timed out after 20000ms (type=taskpage.session.after)')

function fakeClient() {
  const hooks = { link: null as null | ((open: boolean) => void) }
  const client = {
    fetchSnapshot: vi.fn(async () => SNAPSHOT),
    fetchAfter: vi.fn(async () => caughtUp(11)),
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
  return { client: client as unknown as SessionpageTimelineClient, fetchAfter: client.fetchAfter, subscribeSession: client.subscribeSession, hooks }
}

let session: AgentWatchSession
function Probe({ client }: { client: SessionpageTimelineClient }) {
  session = useTimelineSession(client, 'phone', 'machine-1', 'conversation-1', true)
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
/** 回到前台:页面据此补一次缺口。 */
const foreground = () => act(async () => { document.dispatchEvent(new Event('visibilitychange')) })

async function openTimeline(f: ReturnType<typeof fakeClient>) {
  vi.useFakeTimers()
  await harness.render(createNode(Probe, { client: f.client }))
  await advance(500)
  expect(session.phase).toBe('ready')
  expect(session.timeline.turns).toHaveLength(1)
}

describe('补缺口失败(#6738)', () => {
  it('传输层失败:不报错,时间线留着;下一次回前台再补上', async () => {
    const f = fakeClient()
    await openTimeline(f)
    f.fetchAfter.mockRejectedValueOnce(timedOut())
    await foreground()
    await advance(10_000)
    expect(session.error, 'one timeout is not worth a red banner while the timeline is on screen').toBeNull()
    expect(session.phase).toBe('ready')
    expect(f.fetchAfter, 'no retry of its own: the next foreground / reopen re-drives it').toHaveBeenCalledTimes(1)
    await foreground()
    await advance(0)
    expect(session.timeline.cursor?.seq).toBe(11)
  })

  it('机器明确拒绝(会话没了):不重试,当场报;后来补上了就收回', async () => {
    const f = fakeClient()
    await openTimeline(f)
    f.fetchAfter.mockRejectedValueOnce(Object.assign(new Error('这台机器上没有会话 conversation-1'), { code: 'session_not_found' }))
    await foreground()
    await advance(0)
    expect(session.error).toContain('session_not_found')
    await advance(10_000)
    expect(f.fetchAfter).toHaveBeenCalledTimes(1)
    await foreground()
    await advance(0)
    expect(session.error).toBeNull()
  })
})

describe('到那台机器的窗口断了又通(订阅跟着窗口生灭)', () => {
  it('断了标「断开」,时间线留着;又通了就从手里的游标重订、补差量,不整份再拉', async () => {
    const f = fakeClient()
    await openTimeline(f)
    expect(f.subscribeSession).toHaveBeenCalledTimes(1)
    await act(async () => { f.hooks.link?.(false) })
    expect(session.link).toBe('lost')
    expect(session.timeline.turns).toHaveLength(1)
    await act(async () => { f.hooks.link?.(true) })
    await advance(500)
    expect(f.subscribeSession).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.subscribeSession).mock.calls[1]).toEqual(['machine-1', 'conversation-1', expect.any(String), { epoch: 'e1', seq: 10 }])
    expect(f.client.fetchSnapshot, 'resubscribe from the cursor in hand, no full re-pull').toHaveBeenCalledTimes(1)
    expect(session.link).toBe('ok')
  })
})
