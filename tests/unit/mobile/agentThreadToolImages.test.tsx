// @vitest-environment jsdom
//
// owner 10-15「手机上看的话每张图传过去岂不是很 costly,有 lazyload 吗」:手机时间线里工具交回来的图只有字数,
// 图格滚进视口才去机器上取(取到写回条目,跟时间线一起存);超过上限的不取、说在桌面上看;取不到写出来、点一下再取。
// 取不取只看数据(复核 47b50d577):条目被宿主重发、图没带过来时那一格又没了图,照样再取;同一张只发一问。
// 真 useTimelineSession + 真 AgentThread,机器那头是假 client:宿主推来的结果由用例自己推。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolImage, TranscriptTurn } from '@gugu/session-core/acp/client'
import { TOOL_IMAGE_FETCH_LIMIT, type TimelineAfterResult, type TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import type { SessionpageTimelineClient } from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import { createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: vi.fn(() => ({})),
}))

const { AgentThread } = await import('../../../apps/desktop/src/mobile/agent-watch/AgentThread')
const { useTimelineSession } = await import('../../../apps/desktop/src/mobile/agent-watch/use-timeline-session')
const { clearTimelineCache } = await import('../../../apps/desktop/src/mobile/agent-watch/timeline-cache')

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

/** 一轮还在跑(它的过程默认摊开,工具卡渲染出来),里面一次 app_check 交回 `refs` 那几张。 */
const turnsWith = (refs: number[], extra: Record<string, unknown> = {}) => [{
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'check it' },
    { kind: 'mcp-tool-call', id: 'tc1', seq: 1, title: 'mcp__gugu__catalog_call', server: 'gugu', tool: 'catalog_call', status: 'done', outputText: 'ok', imageRefs: refs.map((chars) => ({ mimeType: 'image/jpeg', chars })), ...extra },
  ],
}] as unknown as TranscriptTurn[]
let epoch = 0
const snapshotOf = (turns: TranscriptTurn[]) => ({ cursor: { epoch: `e${++epoch}`, seq: 1 }, turns, settlements: [], hasOlder: false }) as unknown as TimelineSnapshot

const SHOT: ToolImage = { mimeType: 'image/jpeg', data: 'AAAA' }

/** 宿主推来的结果(换代快照 = 整条重发)。 */
let push: (result: TimelineAfterResult) => void = () => undefined
function fakeClient(turns: TranscriptTurn[], fetchToolImage: SessionpageTimelineClient['fetchToolImage']) {
  return {
    fetchSnapshot: vi.fn(async () => snapshotOf(turns)),
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
  } as unknown as SessionpageTimelineClient
}
/** 宿主把那一轮整条重发(换代快照)。 */
const resend = (turns: TranscriptTurn[]) => act(async () => push({ ok: false, reset: 'source_replaced', snapshot: snapshotOf(turns) }))

function Page({ client }: { client: SessionpageTimelineClient }) {
  const session = useTimelineSession(client, 'phone', 'device-1', 'conversation-1', true)
  return (
    <AgentThread
      timeline={session.timeline}
      deviceId="device-1"
      sessionId="conversation-1"
      sessionRuntime="acp"
      respondingItemId={null}
      onRespond={() => undefined}
      onSend={async () => undefined}
      pendingSends={[]}
      sending={false}
      agentWorking
      onStop={() => undefined}
      stopping={false}
      onLoadOlder={async () => undefined}
      onLoadToolImage={session.loadToolImage}
    />
  )
}

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(async () => {
  await clearTimelineCache()
  enters.length = 0
  Element.prototype.scrollTo = () => undefined
  vi.stubGlobal('IntersectionObserver', FakeObserver)
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  vi.unstubAllGlobals()
  Element.prototype.scrollTo = scrollTo
})

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)) })
const render = async (turns: TranscriptTurn[], fetch: SessionpageTimelineClient['fetchToolImage']) => {
  await harness.render(<Page client={fakeClient(turns, fetch)} />)
  await settle()
}
const pending = () => [...harness.container.querySelectorAll('[data-testid="tool-images"] .gg-media-grid-pending')].map((el) => el.textContent)
const pictures = () => harness.container.querySelectorAll('[data-testid="tool-images"] img').length
const scrollIn = async () => {
  await act(async () => enters.forEach((enter) => enter()))
  await settle()
}

describe('手机工具卡下的图(懒取)', () => {
  it('没滚进视口一张都不取;滚进来了每张取一次、画出来,超过上限的不取、写一句话', async () => {
    const fetch = vi.fn(async () => SHOT)
    await render(turnsWith([30_000, 25_000, TOOL_IMAGE_FETCH_LIMIT + 1]), fetch)
    expect(harness.container.querySelectorAll('[data-testid="tool-images"]')).toHaveLength(1)
    expect(fetch).not.toHaveBeenCalled()

    await scrollIn()
    expect(fetch.mock.calls).toEqual([['device-1', 'conversation-1', 'tc1', 0], ['device-1', 'conversation-1', 'tc1', 1]])
    expect(pictures()).toBe(2)
    expect(pending()).toHaveLength(1)
    expect(pending()[0]).not.toBe('')
  })

  it('取不到写出来、❌ 一直空着;点那一格再取一次', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('machine offline')).mockResolvedValue(SHOT)
    await render(turnsWith([30_000]), fetch)
    await scrollIn()
    expect(pending()[0]).not.toBe('')

    await act(async () => (harness.container.querySelector('[data-testid="tool-images"] button') as HTMLButtonElement).click())
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(pictures()).toBe(1)
  })

  it('取到以后宿主重发这一条:同一组图带过去、不再取;refs 变了图没带过来,那一格再取一次(❌ 空着、点了没反应)', async () => {
    const fetch = vi.fn(async () => SHOT)
    await render(turnsWith([30_000]), fetch)
    await scrollIn()
    expect(pictures()).toBe(1)

    await resend(turnsWith([30_000], { outputText: 'resent' }))
    await settle()
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(pictures()).toBe(1)

    await resend(turnsWith([30_001], { outputText: 'another picture' }))
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(pictures()).toBe(1)
  })

  it('正在取的那一张,时间线又更新了几次也 ❌ 发第二问', async () => {
    let release: (image: ToolImage) => void = () => undefined
    const fetch = vi.fn(() => new Promise<ToolImage>((resolve) => { release = resolve }))
    await render(turnsWith([30_000]), fetch)
    await scrollIn()
    for (const text of ['a', 'b', 'c']) {
      await resend(turnsWith([30_000], { outputText: text }))
      await settle()
    }
    expect(fetch).toHaveBeenCalledTimes(1)
    await act(async () => release(SHOT))
    await settle()
    expect(pictures()).toBe(1)
  })
})
