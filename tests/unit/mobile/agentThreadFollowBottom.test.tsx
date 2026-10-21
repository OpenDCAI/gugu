// @vitest-environment jsdom
//
// 2026-09-29 手机实测:会话页发一句、agent 回话,两者都沉在屏幕下沿,要自己点 ↓ 才看得到。
// 真 AgentThread + 真 assistant-ui 视口;jsdom 没有排版,给视口一个最小的高度模型:每行 100、可视 250。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../support/testHarness'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  SessionpageRpcError: class SessionpageRpcError extends Error {},
  fetchSessionOptions: vi.fn(() => new Promise(() => {})),
  setSessionOption: vi.fn(),
  sessionAttachmentRpc: vi.fn(() => ({})),
}))

const { AgentThread } = await import('../../../apps/desktop/src/mobile/agent-watch/AgentThread')
const { emptyAgentWatchTimeline } = await import('../../../apps/desktop/src/mobile/agent-watch/agent-watch-store')

const ROW = 100
const VISIBLE = 250
const isViewport = (el: Element) => el.getAttribute('data-slot') === 'aui_thread-viewport'
const scrollTops = new WeakMap<Element, number>()
const saved = ['scrollHeight', 'clientHeight', 'scrollTop'].map((key) => [key, Object.getOwnPropertyDescriptor(Element.prototype, key)] as const)
const savedScrollTo = Element.prototype.scrollTo

beforeEach(() => {
  Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isViewport(this) ? this.querySelectorAll('[data-message-id]').length * ROW : 0 } })
  Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isViewport(this) ? VISIBLE : 0 } })
  // 内容变矮时浏览器当场把 scrollTop 夹到新的最底;不夹的话「在底部收起一行」会在模型里假装离开了底部。
  Object.defineProperty(Element.prototype, 'scrollTop', { configurable: true, get(this: Element) { return Math.min(scrollTops.get(this) ?? 0, Math.max(0, this.scrollHeight - this.clientHeight)) }, set(this: Element, value: number) { scrollTops.set(this, value) } })
  Element.prototype.scrollTo = function (this: Element, options?: ScrollToOptions | number) {
    const top = typeof options === 'number' ? options : options?.top ?? 0
    scrollTops.set(this, Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight)))
    this.dispatchEvent(new Event('scroll'))
  } as typeof Element.prototype.scrollTo
})
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(Element.prototype, key, descriptor)
    else delete (Element.prototype as unknown as Record<string, unknown>)[key]
  }
  Element.prototype.scrollTo = savedScrollTo
})

const turn = (n: number): TranscriptTurn => ({
  id: `t${n}`,
  seq: n,
  initiator: 'user',
  items: [
    { kind: 'message', id: `u${n}`, seq: 0, role: 'user', text: `Question ${n}` },
    { kind: 'message', id: `a${n}`, seq: 1, role: 'assistant', text: `Answer ${n}` },
  ],
}) as unknown as TranscriptTurn

/** 带一条跑完的工具调用的一轮:给「人点开 / 收起一行」那几格一个能点的东西。 */
const toolTurn = (n: number): TranscriptTurn => ({
  id: `t${n}`,
  seq: n,
  initiator: 'user',
  items: [
    { kind: 'message', id: `u${n}`, seq: 0, role: 'user', text: `Question ${n}` },
    { kind: 'tool-call', id: `tc${n}`, seq: 1, title: 'Bash', status: 'done', rawInput: '{"command":"echo hi"}' },
    { kind: 'message', id: `a${n}`, seq: 2, role: 'assistant', text: `Answer ${n}` },
  ],
}) as unknown as TranscriptTurn

function thread(count: number, make: (n: number) => TranscriptTurn = turn, sending = false) {
  return (
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns: Array.from({ length: count }, (_, i) => make(i + 1)) }}
      deviceId="device-1"
      sessionId="conversation-1"
      sessionRuntime="acp"
      respondingItemId={null}
      onRespond={() => undefined}
      onSend={async () => undefined}
      pendingSends={[]}
      sending={sending}
      agentWorking={false}
      onStop={() => undefined}
      stopping={false}
      onLoadOlder={async () => undefined}
    />
  )
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)) })

describe('手机会话页:新消息跟到底', () => {
  let harness: ReturnType<typeof createReactHarness>
  beforeEach(() => { harness = createReactHarness() })
  afterEach(() => harness.cleanup())
  const viewport = () => harness.container.querySelector<HTMLElement>('[data-slot="aui_thread-viewport"]')!
  const bottom = () => viewport().scrollHeight - viewport().clientHeight

  it('停在底部时来了新的一轮,视口跟到新的底部', async () => {
    await harness.render(thread(2))
    await settle()
    expect(viewport().scrollTop).toBe(bottom())
    // 点输入框打字:手指按下会取消「首屏滚到底」那一次还没落地的请求
    viewport().dispatchEvent(new Event('pointerdown'))
    await harness.render(thread(3))
    await settle()
    expect(viewport().scrollTop).toBe(bottom())
  })

  it('正对照:往上翻着看的时候来了新的一轮,视口不动', async () => {
    await harness.render(thread(3))
    await settle()
    viewport().dispatchEvent(new Event('pointerdown'))
    viewport().scrollTop = 0
    viewport().dispatchEvent(new Event('scroll'))
    await harness.render(thread(4))
    await settle()
    expect(viewport().scrollTop).toBe(0)
  })

  it('停在底部点开一行 = 暂停跟随:来了新的一轮视口不动;滑回底部后再来一轮，又跟到底', async () => {
    await harness.render(thread(2, toolTurn))
    await settle()
    expect(viewport().scrollTop).toBe(bottom())
    viewport().dispatchEvent(new Event('pointerdown'))
    const trigger = viewport().querySelector<HTMLElement>('[data-slot="tool-group-trigger"], [data-slot="tool-fallback-trigger"]')
    expect(trigger, 'a row to open').not.toBeNull()
    await act(async () => { trigger!.click() })
    const pausedAt = viewport().scrollTop
    await harness.render(thread(3, toolTurn))
    await settle()
    expect(viewport().scrollTop, 'paused: the new turn does not pull the viewport').toBe(pausedAt)
    expect(viewport().scrollTop).toBeLessThan(bottom())
    // 人往下一划回到底部 ⇒ 恢复跟随
    viewport().scrollTop = bottom()
    viewport().dispatchEvent(new Event('scroll'))
    await settle()
    await harness.render(thread(4, toolTurn))
    await settle()
    expect(viewport().scrollTop, 'back at the bottom: following again').toBe(bottom())
  })

  it('停在底部收起一行(暂停了、没离开过底部),之后在这台手机上发一句话 ⇒ 回复跟随到底', async () => {
    await harness.render(thread(2, toolTurn))
    await settle()
    viewport().dispatchEvent(new Event('pointerdown'))
    const trigger = viewport().querySelector<HTMLElement>('[data-slot="tool-group-trigger"], [data-slot="tool-fallback-trigger"]')
    expect(trigger, 'a row to toggle').not.toBeNull()
    // 先点开(暂停)、划回底部(恢复),这一行开着、人在底部跟着看。
    await act(async () => { trigger!.click() })
    viewport().scrollTop = bottom()
    viewport().dispatchEvent(new Event('scroll'))
    await settle()
    // 在底部把它收起来:暂停了，内容变矮，人仍在底部 —— 没有「离开底部再回来」那一下。
    await act(async () => { trigger!.click() })
    viewport().dispatchEvent(new Event('scroll'))
    await settle()
    expect(viewport().scrollTop, 'still at the bottom after collapsing').toBe(bottom())
    // 发消息:这台手机「正在发」那一下是官方线程的 isRunning(AgentThread)。
    await harness.render(thread(2, toolTurn, true))
    await settle()
    // 官方视口在 runStart 时留下一次「滚到底」的意图，它只管接下来那一次长高;回复后面接着长的部分要靠跟随。
    await harness.render(thread(3, toolTurn))
    await settle()
    await harness.render(thread(4, toolTurn))
    await settle()
    expect(viewport().scrollTop, 'the reply keeps being followed').toBe(bottom())
  })
})
