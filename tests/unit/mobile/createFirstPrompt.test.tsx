// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import {
  useTimelineSession,
  type AgentWatchSession,
  type SessionpageTimelineClient,
} from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import { clearTimelineCache } from '../../../apps/desktop/src/mobile/agent-watch/timeline-cache'
import { createNode, createReactHarness } from '../../support/testHarness'

/**
 * 2026-09-29 owner 真机:手机新建会话,首句「出现 → 没了 → 闪一下 → 又出现」。新建页画着这句,
 * 换到会话页时这句没带过去,会话页从空时间线起步(读取中 → 等它开口 → 记录到了才重画)。
 * 会话页一挂上就要有这句(一句已受理、在路上的发送),记录里那一行到了让位,始终只有一条。
 */
const FIRST = '帮我看看今天的构建为什么红了'
const withFirstLine: TimelineSnapshot = {
  cursor: { epoch: 'e1', seq: 3 },
  turns: [{ id: 't1', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'record-user-1', seq: 0, role: 'user', text: FIRST }] }],
  settlements: [],
  hasOlder: false,
}

function fakeClient(snapshot: Promise<TimelineSnapshot>) {
  const client = {
    fetchSnapshot: vi.fn(() => snapshot),
    fetchAfter: vi.fn(),
    fetchOlder: vi.fn(),
    subscribeSession: vi.fn(async () => ({})),
    unsubscribeSession: vi.fn(async () => ({})),
    subscribeSessionEvents: vi.fn(() => () => undefined),
    onLinkChange: vi.fn(() => () => undefined),
    sendSessionText: vi.fn(),
    cancelSessionTurn: vi.fn(),
    respondToSettlement: vi.fn(),
  }
  return client as unknown as SessionpageTimelineClient
}

let session: AgentWatchSession
function Probe({ client }: { client: SessionpageTimelineClient }) {
  session = useTimelineSession(client, 'phone', 'machine-1', 'conversation-new', true, FIRST)
  return null
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await clearTimelineCache()
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

describe('新建会话的首句换页不丢', () => {
  it('会话页挂上时时间线还没读到,首句已经在线上;记录那一行到了让位,始终只有一条', async () => {
    let land!: (snapshot: TimelineSnapshot) => void
    await harness.render(createNode(Probe, { client: fakeClient(new Promise((resolve) => { land = resolve })) }))
    expect(session.phase).toBe('loading')
    expect(session.pendingSends.map((send) => send.text)).toEqual([FIRST])

    await act(async () => { land(withFirstLine); await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(session.timeline.turns.flatMap((turn) => turn.items).filter((item) => item.kind === 'message' && item.role === 'user')).toHaveLength(1)
    expect(session.pendingSends).toHaveLength(0)
  })
})
