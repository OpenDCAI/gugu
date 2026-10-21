// @vitest-environment jsdom
//
// owner 10-15:手机时间线里工具交回来的图只有字数(transport-trim)。取一张 = 去那台机器上取、写回手里那条条目 ——
// 就当它本来就带着图,内存这份时间线和本地留存(timeline-cache)都跟着它走,重开不重取。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineAfterResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import {
  useTimelineSession,
  type AgentWatchSession,
  type SessionpageTimelineClient,
} from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import { clearTimelineCache } from '../../../apps/desktop/src/mobile/agent-watch/timeline-cache'
import { createNode, createReactHarness } from '../../support/testHarness'

const SNAPSHOT = {
  cursor: { epoch: 'e1', seq: 3 },
  turns: [{
    id: 't1',
    seq: 1,
    initiator: 'user',
    items: [{ kind: 'mcp-tool-call', id: 'tc1', seq: 1, title: 'app_check', status: 'done', imageRefs: [{ mimeType: 'image/jpeg', chars: 8 }] }],
  }],
  settlements: [],
  hasOlder: false,
} as unknown as TimelineSnapshot
const SHOT = { mimeType: 'image/jpeg', data: '/9j/AAAA' }

/** 宿主推来的结果(换代快照 = 整条重发),由用例自己推。 */
let push: (result: TimelineAfterResult) => void = () => undefined
let epoch = 1
function fakeClient(fetchToolImage: SessionpageTimelineClient['fetchToolImage']) {
  return {
    fetchSnapshot: vi.fn(async () => SNAPSHOT),
    fetchAfter: vi.fn(),
    fetchOlder: vi.fn(),
    fetchToolImage,
    subscribeSession: vi.fn(async () => ({})),
    unsubscribeSession: vi.fn(async () => ({})),
    subscribeSessionEvents: vi.fn((_device: string, _subscription: string, onResult: (result: TimelineAfterResult) => void) => {
      push = onResult
      return () => undefined
    }),
    onLinkChange: vi.fn(() => () => undefined),
    sendSessionText: vi.fn(),
    cancelSessionTurn: vi.fn(),
    respondToSettlement: vi.fn(),
  } as unknown as SessionpageTimelineClient
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
afterEach(() => harness.cleanup())

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const item = () => session.timeline.turns[0]!.items[0] as unknown as { images?: unknown[] }

describe('取一张工具图', () => {
  it('去那台机器上按 (会话, 条目, 第几张) 取,取到写回那条条目', async () => {
    const fetchToolImage = vi.fn(async () => SHOT)
    await harness.render(createNode(Probe, { client: fakeClient(fetchToolImage) }))
    await settle()
    expect(item().images).toBeUndefined()

    await act(async () => session.loadToolImage('tc1', 0))
    expect(fetchToolImage).toHaveBeenCalledWith('machine-1', 'conversation-1', 'tc1', 0)
    expect(item().images).toEqual([SHOT])
  })

  it('取不到原样抛给调用的那格(画成取不到),时间线不动', async () => {
    const fetchToolImage = vi.fn(async () => {
      throw new Error('no_such_item')
    })
    await harness.render(createNode(Probe, { client: fakeClient(fetchToolImage) }))
    await settle()
    await expect(act(async () => session.loadToolImage('tc1', 0))).rejects.toThrow('no_such_item')
    expect(item().images).toBeUndefined()
  })

  // 每一问各自挂着,由用例按次序放回。问的次数在发问当下就判:多发的那一问 ❌ 等它回来才看出来(它没人放就永远不回)。
  const pendingAsks = () => {
    const asks: ((image: typeof SHOT) => void)[] = []
    const fetchToolImage = vi.fn(() => new Promise<typeof SHOT>((resolve) => { asks.push(resolve) }))
    return { asks, fetchToolImage }
  }

  // 2026-10-15 mac1 实测:回包一到就放手,写回还排在下一次渲染里的那一小段,图格照旧没图又要了一遍(每阶段 4–7 张)。
  it('取到了、写回还没画上的那一小段里再要,❌ 再问', async () => {
    const { asks, fetchToolImage } = pendingAsks()
    await harness.render(createNode(Probe, { client: fakeClient(fetchToolImage) }))
    await settle()

    await act(async () => {
      const first = session.loadToolImage('tc1', 0)
      asks[0]!(SHOT)
      await first
      // 还在同一个 act 里:写回排着,还没渲染。
      expect(item().images).toBeUndefined()
      const again = session.loadToolImage('tc1', 0)
      expect(fetchToolImage).toHaveBeenCalledTimes(1)
      await again
    })
    expect(item().images).toEqual([SHOT])
  })

  it('同一张正在取的合成一问(图格重挂时 ❌ 再发一问)', async () => {
    const { asks, fetchToolImage } = pendingAsks()
    await harness.render(createNode(Probe, { client: fakeClient(fetchToolImage) }))
    await settle()

    let first!: Promise<void>
    let second!: Promise<void>
    await act(async () => {
      first = session.loadToolImage('tc1', 0)
      second = session.loadToolImage('tc1', 0)
    })
    expect(fetchToolImage).toHaveBeenCalledTimes(1)
    await act(async () => {
      asks[0]!(SHOT)
      await Promise.all([first, second])
    })
    expect(item().images).toEqual([SHOT])
  })

  /** 那台机器把这条会话整条重发(换代快照):这一轮的条目换成 `items`。 */
  const resend = (items: unknown[]) => act(async () => push({
    ok: false,
    reset: 'source_replaced',
    snapshot: { ...SNAPSHOT, cursor: { epoch: `e${++epoch}`, seq: 4 }, turns: [{ ...SNAPSHOT.turns[0]!, items }] } as unknown as TimelineSnapshot,
  }))
  const call = SNAPSHOT.turns[0]!.items[0]!

  it('画上了就放手:之后条目被重发、图没带过来,再要就再取', async () => {
    const fetchToolImage = vi.fn(async () => SHOT)
    await harness.render(createNode(Probe, { client: fakeClient(fetchToolImage) }))
    await settle()
    await act(async () => session.loadToolImage('tc1', 0))
    await settle()
    expect(item().images).toEqual([SHOT])

    // 这一张变了(字数不同):带不过来,手里没有了。
    await resend([{ ...call, imageRefs: [{ mimeType: 'image/jpeg', chars: 9 }] }])
    await settle()
    expect(item().images).toBeUndefined()
    await act(async () => session.loadToolImage('tc1', 0))
    expect(fetchToolImage).toHaveBeenCalledTimes(2)
    expect(item().images).toEqual([SHOT])
  })

  // 复核·二代 10-16:取的途中条目离开了手里这份(换了会话、换代快照没带那一轮),答复写不进去,可那一问还记着
  // 「取到了」,条目回来时被当成正在取 —— 回来以后问 0 次,那几格一直空着、点了也没反应。
  it('取的途中条目离开了、答复写不进去 ⇒ 当场放手;条目回来再要就再取', async () => {
    const { asks, fetchToolImage } = pendingAsks()
    await harness.render(createNode(Probe, { client: fakeClient(fetchToolImage) }))
    await settle()
    let first!: Promise<void>
    await act(async () => { first = session.loadToolImage('tc1', 0) })
    await resend([])
    await settle()
    await act(async () => {
      asks[0]!(SHOT)
      await first
    })
    await settle()

    await resend([call])
    await settle()
    const again = session.loadToolImage('tc1', 0)
    expect(fetchToolImage).toHaveBeenCalledTimes(2)
    await act(async () => {
      asks[1]!(SHOT)
      await again
    })
    expect(item().images).toEqual([SHOT])
  })

  it('写进去以后条目又被换走 ⇒ 也放手;条目回来再要就再取', async () => {
    const { asks, fetchToolImage } = pendingAsks()
    await harness.render(createNode(Probe, { client: fakeClient(fetchToolImage) }))
    await settle()
    await act(async () => {
      const first = session.loadToolImage('tc1', 0)
      asks[0]!(SHOT)
      await first
      // 写回排着还没画上,宿主就整条重发、这一轮暂时不带它。
      push({ ok: false, reset: 'source_replaced', snapshot: { ...SNAPSHOT, cursor: { epoch: `e${++epoch}`, seq: 4 }, turns: [{ ...SNAPSHOT.turns[0]!, items: [] }] } as unknown as TimelineSnapshot })
    })
    await settle()

    await resend([call])
    await settle()
    const again = session.loadToolImage('tc1', 0)
    expect(fetchToolImage).toHaveBeenCalledTimes(2)
    await act(async () => {
      asks[1]!(SHOT)
      await again
    })
    expect(item().images).toEqual([SHOT])
  })
})
