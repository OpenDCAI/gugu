// @vitest-environment jsdom
//
// 复核·二代 10-16(#7228):手机每张工具图去机器上问几次 —— 真 useTimelineSession 驱动真 AgentThread(真 assistant-ui),
// 机器那头是假 client。图格一上屏就交给 React 自己的调度(不包 act):assistant-ui 在 effect 里才换上新消息,真的会晚一拍;
// 图格要是读那一份,就会对着早已取到的图再问(mac1 10-16:往上翻 64 张问了 74 次;这里 12 张问到 17 次)。
// 答复按几种节奏回来,多问的也照答。等的是事实(`until`);末尾是任务边界(setImmediate),❌ 墙钟当判据 ——
// 16 ms 那一种是答复的节奏,不是在等什么。
// 改编自 2026-10-15 复核的探针。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { TimelineAfterResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import { until } from '../../support/awaitCondition'
import { createNode, createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: vi.fn(() => ({})),
}))

const { AgentThread } = await import('../../../apps/desktop/src/mobile/agent-watch/AgentThread')
const { useTimelineSession } = await import('../../../apps/desktop/src/mobile/agent-watch/use-timeline-session')
const { clearTimelineCache } = await import('../../../apps/desktop/src/mobile/agent-watch/timeline-cache')

const actEnv = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

/** 由用例自己说「滚进视口了」的 IntersectionObserver。 */
const enters: (() => void)[] = []
class FakeObserver {
  readonly callback: IntersectionObserverCallback
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback
  }
  observe() {
    enters.push(() => this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver))
  }
  disconnect() {}
}

const SHOT = { mimeType: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' }
const PER_CALL = 6
const CALLS = ['tc1', 'tc2']
const TOTAL = PER_CALL * CALLS.length
/** 答到这么多问就不再答:一处回归要是问个不停,用例照样走完、按次数判红,❌ 一直答下去挂住。 */
const ANSWER_CAP = TOTAL * 3

const call = (id: string, seq: number, text = 'ok') => ({
  kind: 'mcp-tool-call', id, seq, title: 'mcp__gugu__catalog_call', server: 'gugu', tool: 'catalog_call', status: 'done', outputText: text,
  imageRefs: Array.from({ length: PER_CALL }, () => ({ mimeType: 'image/png', chars: 30_000 })),
})
/**
 * 一轮还在跑(过程默认摊开),里面这几次调用各交回 6 张。
 * 调用之间隔一句 agent 的话:连着的调用会收成一组、默认收着(#7316,owner 10-16),卡不上屏图就不问;
 * 隔开后每次调用都是单独一条 = 一行,工具卡照常渲染 —— 这里数的是「每张图问几次」,与折不折无关。
 */
const turnWith = (ids: string[], text = 'ok') => [{
  id: 't1', seq: 1, initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'check it' },
    ...ids.flatMap((id, i) => [
      ...(i > 0 ? [{ kind: 'message', id: `a-${id}`, seq: 2 * i, role: 'assistant', text: 'next' }] : []),
      call(id, 2 * i + 1, text),
    ]),
  ],
}] as unknown as TranscriptTurn[]
let epoch = 0
const snapshotOf = (turns: TranscriptTurn[]) => ({ cursor: { epoch: `e${++epoch}`, seq: 1 }, turns, settlements: [], hasOlder: false }) as unknown as TimelineSnapshot

/** 机器那头:每一问都挂着,由用例按节奏答;宿主推来的结果(换代快照 = 整条重发)也由用例推。 */
function fakeMachine() {
  let push: (result: TimelineAfterResult) => void = () => undefined
  const asks: (() => void)[] = []
  const fetchToolImage = vi.fn(() => new Promise<typeof SHOT>((resolve) => asks.push(() => resolve(SHOT))))
  const client = {
    fetchSnapshot: vi.fn(async () => snapshotOf(turnWith(CALLS))),
    fetchAfter: vi.fn(() => new Promise(() => {})),
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
  }
  return { client, fetchToolImage, asks, push: (result: TimelineAfterResult) => push(result) }
}

function Page({ client }: { client: never }) {
  const session = useTimelineSession(client, 'phone', 'machine-1', 'conversation-1', true)
  return createNode(AgentThread, {
    timeline: session.timeline,
    deviceId: 'machine-1',
    sessionId: 'conversation-1',
    sessionRuntime: 'acp',
    respondingItemId: null,
    onRespond: () => undefined,
    onSend: async () => undefined,
    pendingSends: [],
    sending: false,
    agentWorking: true,
    onStop: () => undefined,
    stopping: false,
    onLoadOlder: async () => undefined,
    onLoadToolImage: session.loadToolImage,
  })
}

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(async () => {
  await clearTimelineCache()
  enters.length = 0
  Element.prototype.scrollTo = () => undefined
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  actEnv.IS_REACT_ACT_ENVIRONMENT = true
  harness = createReactHarness()
})
afterEach(() => {
  actEnv.IS_REACT_ACT_ENVIRONMENT = true
  harness.cleanup()
  vi.unstubAllGlobals()
  Element.prototype.scrollTo = scrollTo
})

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const immediate = () => new Promise<void>((r) => setImmediate(r))
const pictures = () => harness.container.querySelectorAll('[data-testid="tool-images"] img').length
const pendingTexts = () => [...harness.container.querySelectorAll('[data-testid="tool-images"] .gg-media-grid-pending')].map((el) => el.textContent)

const RHYTHMS: Record<string, (machine: ReturnType<typeof fakeMachine>, answered: number) => Promise<void>> = {
  'all in one tick': async () => undefined,
  'a microtask apart': async () => { await Promise.resolve() },
  'a task apart (setImmediate)': async () => { await immediate() },
  'a timer apart (0)': async () => { await new Promise((r) => setTimeout(r, 0)) },
  'a frame apart (16 ms)': async () => { await new Promise((r) => setTimeout(r, 16)) },
  'a task apart, the host re-sending the turn every other answer': async (machine, answered) => {
    if (answered % 2 === 0) machine.push({ ok: false, reset: 'source_replaced', snapshot: snapshotOf(turnWith(CALLS, `resent ${answered}`)) })
    await immediate()
  },
}

describe('手机工具图:每张只问一次,图格读时间线这一份(React 自己调度)', () => {
  for (const [rhythm, gap] of Object.entries(RHYTHMS)) {
    it(`答复${rhythm}:${TOTAL} 张问 ${TOTAL} 次,全画上`, async () => {
      const machine = fakeMachine()
      await harness.render(createNode(Page, { client: machine.client as never }))
      await settle()
      await act(async () => enters.forEach((enter) => enter()))
      await until('every picture asked once', () => machine.asks.length, (n) => n >= TOTAL)
      // 从这里起 React 走它自己的调度。
      actEnv.IS_REACT_ACT_ENVIRONMENT = false
      let answered = 0
      const answerOpen = async () => {
        while (machine.asks.length > 0 && answered < ANSWER_CAP) {
          machine.asks.shift()!()
          answered += 1
          await gap(machine, answered)
        }
      }
      await answerOpen()
      await until('every picture drawn', () => pictures(), (n) => n === TOTAL)
      // 末尾 40 个任务边界:这里冒出来的问也照答(它会让下面的次数变多)。
      for (let round = 0; round < 40; round += 1) {
        await immediate()
        if (machine.asks.length > 0 && answered < ANSWER_CAP) {
          await answerOpen()
          round = 0
        }
      }
      expect(machine.fetchToolImage).toHaveBeenCalledTimes(TOTAL)
      expect(pictures()).toBe(TOTAL)
    })
  }

  // 复核·二代 10-16(追记 2):条目离开时间线(换代快照没带那一轮、换了会话),它的卡还会在屏上多留一两次提交(assistant-ui
  // 那一份);图格读时间线,那时已经没有它 —— ❌ 当成「还没取」把早已画上的图再要一遍(改前 6 张问 6 次)。
  it('图早画上了、条目离开时间线:屏上的旧卡 ❌ 再要', async () => {
    const machine = fakeMachine()
    await harness.render(createNode(Page, { client: machine.client as never }))
    await settle()
    await act(async () => enters.forEach((enter) => enter()))
    await until('every picture asked once', () => machine.asks.length, (n) => n >= TOTAL)
    await act(async () => { while (machine.asks.length > 0) machine.asks.shift()!() })
    await settle()
    expect(pictures()).toBe(TOTAL)

    await act(async () => machine.push({ ok: false, reset: 'source_replaced', snapshot: snapshotOf(turnWith(['tc2'])) }))
    await settle()
    await settle()
    expect(machine.fetchToolImage).toHaveBeenCalledTimes(TOTAL)
    expect(pictures()).toBe(PER_CALL)
  })

  // 复核·二代 10-16:取的途中条目离开了时间线(换代快照暂时不带它),答复写不进去;它回来以后要再取、全画上,
  // ❌ 那几格一直空着、点了没反应(改前:回来以后问 0 次,画上 6/12)。
  it('取的途中条目离开、又回来:回来以后那几张再取一次,全画上,没有空着的格', async () => {
    const machine = fakeMachine()
    await harness.render(createNode(Page, { client: machine.client as never }))
    await settle()
    await act(async () => enters.forEach((enter) => enter()))
    await until('every picture asked once', () => machine.asks.length, (n) => n >= TOTAL)
    await act(async () => machine.push({ ok: false, reset: 'source_replaced', snapshot: snapshotOf(turnWith(['tc2'])) }))
    await settle()
    // 这时每一问都答了:tc1 那 6 张没地方写。
    await act(async () => { while (machine.asks.length > 0) machine.asks.shift()!() })
    await settle()
    const asksWhileGone = machine.fetchToolImage.mock.calls.length
    expect(asksWhileGone).toBe(TOTAL)

    // tc1 回来了(宿主发来的样子:只有 refs),滚进视口。
    enters.length = 0
    await act(async () => machine.push({ ok: false, reset: 'source_replaced', snapshot: snapshotOf(turnWith(CALLS)) }))
    await settle()
    await act(async () => enters.forEach((enter) => enter()))
    await settle()
    expect(machine.fetchToolImage.mock.calls.length - asksWhileGone).toBe(PER_CALL)
    await act(async () => { while (machine.asks.length > 0) machine.asks.shift()!() })
    await settle()
    expect(pictures()).toBe(TOTAL)
    expect(pendingTexts()).toEqual([])
  })
})
