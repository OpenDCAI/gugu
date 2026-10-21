// @vitest-environment jsdom
//
// #6726 往前补进更早的轮之后,每句提问下面仍是它自己的回复,也不冒出分支切换器。
// 真 AgentThread + 真 assistant-ui 运行时:先给后四轮,再给全部八轮(就是「载入更早的轮次」那一步)。
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

const turn = (n: number): TranscriptTurn => ({
  id: `t${n}`,
  seq: n,
  initiator: 'user',
  items: [
    { kind: 'message', id: `u${n}`, seq: 0, role: 'user', text: `Question ${n}` },
    { kind: 'message', id: `a${n}`, seq: 1, role: 'assistant', text: `Answer ${n}` },
  ],
}) as unknown as TranscriptTurn

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(() => {
  // jsdom 没有 Element.scrollTo,assistant-ui 的视口贴底会调它。
  Element.prototype.scrollTo = () => undefined
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  Element.prototype.scrollTo = scrollTo
})

function thread(numbers: number[]) {
  return (
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns: numbers.map(turn) }}
      deviceId="device-1"
      sessionId="conversation-1"
      sessionRuntime="acp"
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

const rows = () => [...harness.container.querySelectorAll('[data-role]')].map((el) => (el.textContent ?? '').trim())

describe('#6726 载入更早的轮次后回复不错位', () => {
  it('前面补进四轮:每句提问后面紧跟它自己的回复,没有「n / m」分支切换器', async () => {
    await harness.render(thread([5, 6, 7, 8]))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await harness.render(thread([1, 2, 3, 4, 5, 6, 7, 8]))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const shown = rows()
    expect(shown.filter((text) => text.startsWith('Question'))).toHaveLength(8)
    shown.forEach((text, index) => {
      const asked = /^Question (\d+)/.exec(text)
      if (asked) expect(shown[index + 1]).toContain(`Answer ${asked[1]}`)
    })
    expect(shown.some((text) => /\d+ \/ \d+/.test(text))).toBe(false)
  })

  // #6952 已有的行要是原来那几个 DOM 节点:换成新建的行,它们先按 content-visibility 的 200px 占位、下一帧才量出真高,
  // 读者正看着的那一行就跟着跳;新建的行还会把入场动画重播一遍。
  it('前面补进四轮:原来那几行还是原来的 DOM 节点,也不重播入场动画', async () => {
    await harness.render(thread([5, 6, 7, 8]))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const before = [...harness.container.querySelectorAll('[data-message-id]')]
    const ids = new Set(before.map((el) => el.getAttribute('data-message-id')))
    expect(before.length).toBeGreaterThan(0)
    await harness.render(thread([1, 2, 3, 4, 5, 6, 7, 8]))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const after = [...harness.container.querySelectorAll('[data-message-id]')].filter((el) => ids.has(el.getAttribute('data-message-id')))
    expect(after).toHaveLength(before.length)
    after.forEach((el, index) => {
      expect(el).toBe(before[index])
      expect(el.className).not.toMatch(/animate-in/)
    })
    // 补进来的是更早的历史,不是新到的:也不播入场动画(紧挨着读者那一行的就在屏上,它的位移动画会让滚动锚定失效)
    const older = [...harness.container.querySelectorAll('[data-message-id]')].filter((el) => !ids.has(el.getAttribute('data-message-id')))
    expect(older.length).toBeGreaterThan(0)
    older.forEach((el) => expect(el.className).not.toMatch(/animate-in/))
  })

  it('末尾新到的一轮照常播入场动画(补页之后也一样)', async () => {
    await harness.render(thread([5, 6, 7, 8]))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await harness.render(thread([1, 2, 3, 4, 5, 6, 7, 8]))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    await harness.render(thread([1, 2, 3, 4, 5, 6, 7, 8, 9]))
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const rows = [...harness.container.querySelectorAll('[data-message-id]')]
    expect(rows.at(-1)?.textContent).toContain('Answer 9')
    expect(rows.at(-1)?.className).toMatch(/animate-in/)
  })
})
