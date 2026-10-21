// @vitest-environment jsdom
//
// 2026-10-02 owner 手机实测,同日 mac1 安卓模拟器复现(Claude Code 形态,AskUserQuestion 3 题 × 4 选项):
//   ① 提问卡一出来屏幕就滑不动:卡片钉在贴底的输入框带里,卡高 1233 > 视口 778,整个视口被盖住;
//   ② 退出再进,卡片没了:本地底稿存了游标却不存结算,对账只补游标之后变过的结算。
// 2026-10-12 owner 手机实测,同日 mac1 安卓模拟器(WebView 113)复现(Claude Code 形态,单题):
//   ③ 答完卡一直钉在末尾,后面的消息都画在它上面;④ 刷新后卡没了,只剩那条回答消息。
//   根子:工具行的 id 是 `${turnId}:tool:${toolCallId}`,结算按裸 toolCallId 记,卡永远挂不上那一行。
//   ⇒ 下面的轮照真形状造(item id ≠ toolCallId);从前的夹具把两者写成同一个值,所以一直是绿的。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type {
  Settlement,
  TimelineAfterResult,
  TimelineSnapshot,
} from '@gugu/session-core/session-record/contract'
import { createNode, createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: vi.fn(() => ({})),
}))

const { AgentThread } = await import('../../../apps/desktop/src/mobile/agent-watch/AgentThread')
const { emptyAgentWatchTimeline } = await import('../../../apps/desktop/src/mobile/agent-watch/agent-watch-store')
const { useTimelineSession } = await import('../../../apps/desktop/src/mobile/agent-watch/use-timeline-session')
const { clearTimelineCache, forgetInMemoryTimelines } = await import('../../../apps/desktop/src/mobile/agent-watch/timeline-cache')
type AgentWatchSession = ReturnType<typeof useTimelineSession>
type SessionpageTimelineClient = Parameters<typeof useTimelineSession>[0]

const QUESTION: Settlement = {
  itemId: 'ask-1',
  kind: 'question',
  title: 'Which color theme should the demo page use?',
  options: [{ optionId: 'Warm red', name: 'Warm red' }, { optionId: 'Ocean blue', name: 'Ocean blue' }],
  questions: [
    { question: 'Which color theme should the demo page use?', multiSelect: false, options: [{ optionId: 'Warm red', name: 'Warm red' }, { optionId: 'Ocean blue', name: 'Ocean blue' }] },
    { question: 'Which layout should the page use?', multiSelect: false, options: [{ optionId: 'Single column', name: 'Single column' }, { optionId: 'Two columns', name: 'Two columns' }] },
  ],
  state: 'pending',
  optionId: null,
  resolvedBy: null,
  resolvedAt: null,
}

// 一轮还没结算(没有 outcome):用户那句 + 停在等人答的 AskUserQuestion。
const TURNS = [{
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: '问我三个问题' },
    { kind: 'unknown-tool-call', id: 't1:tool:ask-1', seq: 1, toolCallId: 'ask-1', title: 'AskUserQuestion', name: 'AskUserQuestion', status: 'running' },
  ],
}] as unknown as TranscriptTurn[]
const LATER = { id: 't2', seq: 2, initiator: 'user', outcome: { kind: 'done' }, items: [
  { kind: 'message', id: 'u2', seq: 0, role: 'user', text: '我在咕咕的提问卡里回答了你刚才的提问' },
  { kind: 'message', id: 'a2', seq: 1, role: 'assistant', text: '收到,用 Ocean blue' },
] } as unknown as TranscriptTurn

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(async () => {
  Element.prototype.scrollTo = () => undefined
  await clearTimelineCache()
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  Element.prototype.scrollTo = scrollTo
  vi.useRealTimers()
})

function thread(turns: TranscriptTurn[], question: Settlement) {
  return (
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), cursor: { epoch: 'e1', seq: 3 }, turns, settlements: { 'ask-1': question } }}
      deviceId="device-1"
      sessionId="conversation-1"
      sessionRuntime="pty"
      respondingItemId={null}
      onRespond={() => undefined}
      onSend={async () => undefined}
      pendingSends={[]}
      sending={false}
      agentWorking={false}
      onStop={() => undefined}
      stopping={false}
      onLoadOlder={async () => undefined}
    />
  )
}
const settle = async () => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const cardsNow = () => [...harness.container.querySelectorAll('[data-testid="agent-watch-settlement"]')]

describe('提问卡画在问出它的那一行,❌ 钉在末尾(也 ❌ 钉进贴底的输入框带)', () => {
  it('等答:卡在消息流里、问它的那一轮里;末尾那一组与输入框带里都没有它', async () => {
    await harness.render(thread(TURNS, QUESTION))
    await settle()
    const cards = cardsNow()
    expect(cards.map((card) => card.getAttribute('data-item-id'))).toEqual(['ask-1'])
    const card = cards[0]!
    expect(card.closest('.aui-thread-viewport-footer'), 'inside the sticky composer band').toBeNull()
    expect(card.closest('[data-testid="agent-watch-pinned-settlements"]'), 'pinned at the tail').toBeNull()
    expect(card.closest('[data-message-id]'), 'inside a message of the flow').not.toBeNull()
    expect(card.querySelector('[data-testid="agent-watch-settlement-submit"]'), 'answerable').not.toBeNull()
  })

  it('答完、后面又来了一轮:卡留在原处,新的一轮排在它下面;刷新(重新挂载)后同一个样子', async () => {
    const answered: Settlement = { ...QUESTION, state: 'resolved', resolvedBy: 'mobile', resolvedAt: 2, resultRecorded: true }
    await harness.render(thread([...TURNS, LATER], answered))
    await settle()
    const read = () => {
      const card = cardsNow()[0]!
      const later = harness.container.querySelector('[data-message-id="u2"]')!
      return {
        count: cardsNow().length,
        pinned: card.closest('[data-testid="agent-watch-pinned-settlements"]') !== null,
        laterBelow: (card.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0,
        answered: card.querySelector('[data-testid="agent-watch-settlement-answered"]') !== null,
        text: card.textContent,
      }
    }
    const live = read()
    expect(live).toMatchObject({ count: 1, pinned: false, laterBelow: true, answered: true })

    harness.cleanup()
    harness = createReactHarness()
    await harness.render(thread([...TURNS, LATER], answered))
    await settle()
    expect(read(), 'same after a refresh').toEqual(live)
  })
})

/** 照宿主的语义:快照带全部结算,`after` 只带游标之后变过的(timeline.ts batchAfter)。 */
function hostLikeClient(afterSettlements: Settlement[] = []) {
  const snapshot: TimelineSnapshot = { cursor: { epoch: 'e1', seq: 3 }, turns: TURNS, settlements: [QUESTION], hasOlder: false }
  const after = (): TimelineAfterResult => ({
    ok: true,
    batch: { from: 3, cursor: { epoch: 'e1', seq: afterSettlements.length > 0 ? 4 : 3 }, turns: [], removedTurnIds: [], settlements: afterSettlements },
  })
  const client = {
    fetchSnapshot: vi.fn(async () => snapshot),
    fetchAfter: vi.fn(async () => after()),
    fetchOlder: vi.fn(),
    subscribeSession: vi.fn(async () => ({})),
    unsubscribeSession: vi.fn(async () => ({})),
    subscribeSessionEvents: vi.fn(() => () => undefined),
    onLinkChange: vi.fn(() => () => undefined),
    sendSessionText: vi.fn(),
    cancelSessionTurn: vi.fn(),
    respondToSettlement: vi.fn(),
  }
  return client
}

let session: AgentWatchSession
function Probe({ client }: { client: SessionpageTimelineClient }) {
  session = useTimelineSession(client, 'phone', 'machine-1', 'conversation-1', true)
  return null
}

async function open(client: ReturnType<typeof hostLikeClient>) {
  await harness.render(createNode(Probe, { client: client as unknown as SessionpageTimelineClient }))
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
}

describe('退出再进,待答的提问还在(结算与游标一起存)', () => {
  it('内存底稿:第二次进来只补差量,差量里没有它,卡片照样在', async () => {
    vi.useFakeTimers()
    const first = hostLikeClient()
    await open(first)
    expect(session.timeline.settlements['ask-1']?.state).toBe('pending')
    harness.cleanup()

    harness = createReactHarness()
    const second = hostLikeClient()
    await open(second)
    expect(second.fetchSnapshot, 'the cached cursor is reused, no full snapshot').not.toHaveBeenCalled()
    expect(second.fetchAfter).toHaveBeenCalled()
    expect(session.timeline.settlements['ask-1']?.state).toBe('pending')
  })

  it('冷启动(只剩库里那份):同样还在', async () => {
    vi.useFakeTimers()
    await open(hostLikeClient())
    harness.cleanup()
    await act(async () => { await vi.advanceTimersByTimeAsync(0) })
    forgetInMemoryTimelines()

    harness = createReactHarness()
    const second = hostLikeClient()
    await open(second)
    expect(second.fetchSnapshot).not.toHaveBeenCalled()
    expect(session.timeline.settlements['ask-1']?.state).toBe('pending')
  })

  it('走开期间在别处答掉了:游标之后那一步照样补进来,❌ 留一张早已失效的待答卡', async () => {
    vi.useFakeTimers()
    await open(hostLikeClient())
    harness.cleanup()

    harness = createReactHarness()
    const answered: Settlement = { ...QUESTION, state: 'resolved', optionId: 'Warm red', resolvedBy: 'desktop', resolvedAt: 9 }
    await open(hostLikeClient([answered]))
    expect(session.timeline.settlements['ask-1']?.state).toBe('resolved')
  })
})

// 2026-10-12 owner 手机实测「进运行中的任务页颤两下」:内存里明明有上次那份,第一帧还是空线程(写着「Nothing in this task yet」),
// 等 effect 换上之后整段历史才出来。读的是**每一次渲染**看到的那份,❌ 只读最后一次(最后一次在修前修后都对)。
describe('再进一条看过的任务:第一帧就是上次那份', () => {
  const renders: { turns: number; phase: string }[] = []
  function Recorder({ client }: { client: SessionpageTimelineClient }) {
    const seen = useTimelineSession(client, 'phone', 'machine-1', 'conversation-1', true)
    renders.push({ turns: seen.timeline.turns.length, phase: seen.phase })
    return null
  }
  const mount = async (client: ReturnType<typeof hostLikeClient>) => {
    renders.length = 0
    await harness.render(createNode(Recorder, { client: client as unknown as SessionpageTimelineClient }))
    await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  }

  it('第一次进(内存里没有)第一帧是空的(阴控:仪器看得见空帧);再进第一帧就有内容', async () => {
    vi.useFakeTimers()
    await mount(hostLikeClient())
    expect(renders[0]).toEqual({ turns: 0, phase: 'loading' })
    expect(renders.at(-1)?.turns).toBe(1)
    harness.cleanup()

    harness = createReactHarness()
    await mount(hostLikeClient())
    expect(renders[0]).toEqual({ turns: 1, phase: 'ready' })
    expect(renders.every((render) => render.turns === 1)).toBe(true)
  })
})
