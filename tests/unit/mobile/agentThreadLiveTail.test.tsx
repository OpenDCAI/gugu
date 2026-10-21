// @vitest-environment jsdom
//
// owner 10-09 真机:页头写着「运行中」,最后一条回复下面已经挂着「复制 / ⋯」—— 读起来是「还在跑却能复制了」。
// 页头说在跑时,最后一条的动作栏那一格换成「正在回」的点;不是最后一条的回复不画动作栏那一格。
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

const turns = [
  {
    id: 't1', seq: 1, initiator: 'user', outcome: 'completed',
    items: [
      { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'first' },
      { kind: 'message', id: 'a1', seq: 1, role: 'assistant', text: 'earlier reply' },
    ],
  },
  {
    id: 't2', seq: 2, initiator: 'user', outcome: 'completed',
    items: [
      { kind: 'message', id: 'u2', seq: 0, role: 'user', text: 'second' },
      { kind: 'message', id: 'a2', seq: 1, role: 'assistant', text: 'latest reply' },
    ],
  },
] as unknown as TranscriptTurn[]

let harness: ReturnType<typeof createReactHarness>
const scrollTo = Element.prototype.scrollTo
beforeEach(() => {
  Element.prototype.scrollTo = () => undefined
  harness = createReactHarness()
})
afterEach(() => {
  harness.cleanup()
  Element.prototype.scrollTo = scrollTo
})

async function render(headerRunning: boolean) {
  await harness.render(
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns }}
      deviceId="device-1"
      sessionId="conversation-1"
      sessionRuntime="acp"
      respondingItemId={null}
      onRespond={() => undefined}
      onSend={async () => undefined}
      pendingSends={[]}
      sending={false}
      agentWorking={false}
      headerRunning={headerRunning}
      onStop={() => undefined}
      stopping={false}
      onLoadOlder={async () => undefined}
    />,
  )
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  const turnOf = (text: string) => [...harness.container.querySelectorAll('[data-slot="assistant-turn"]')].find((el) => el.textContent?.includes(text))
  return { earlier: turnOf('earlier reply'), latest: turnOf('latest reply') }
}

describe('最后一条回复下面:页头在跑 = 正在回的点;不在跑 = 动作栏', () => {
  it('页头说在跑:只有最后一条带点', async () => {
    const { earlier, latest } = await render(true)
    expect(latest?.getAttribute('data-live')).toBe('true')
    expect(latest?.querySelector('.gg-aw-live-tail-dot')).not.toBeNull()
    expect(earlier?.getAttribute('data-live')).toBeNull()
  })

  it('页头不说在跑:没有点;只有最后一条带 data-last(动作栏那一格只留给它)', async () => {
    const { earlier, latest } = await render(false)
    expect(harness.container.querySelector('.gg-aw-live-tail-dot')).toBeNull()
    expect(latest?.getAttribute('data-last')).toBe('true')
    expect(earlier?.getAttribute('data-last')).toBeNull()
  })
})
