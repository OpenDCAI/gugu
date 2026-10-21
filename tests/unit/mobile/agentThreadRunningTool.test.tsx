// @vitest-environment jsdom
//
// 设计同事 10-05 真机:一条还在跑的 Bash,手机上卡片自己摊开、画出「允许 / 拒绝」—— 看着像在等批准,其实什么也不拦。
// 没出结果的工具卡,assistant-ui 拿消息的状态当它的;消息不写状态时由官方推,而手机线程的 isRunning 只算「这台手机
// 正在发」⇒ 推成 requires-action,走的是「客户端自己交工具结果」那条路。在跑的就该是在跑(转圈),跑完的就是跑完。
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

// 跑完的那条没有输出、和在跑的那条同在一轮(同一条消息)里:官方的「消息状态」分不开它俩。
const turns = [{
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'make a dir, then wait' },
    { kind: 'tool-call', id: 'tc1', seq: 1, title: 'Bash', status: 'done', rawInput: '{"command":"mkdir out"}' },
    { kind: 'tool-call', id: 'tc2', seq: 2, title: 'Bash', status: 'running', rawInput: '{"command":"sleep 300"}' },
  ],
}] as unknown as TranscriptTurn[]

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

describe('手机会话页:还在跑的工具', () => {
  it('卡片在转、没有「允许 / 拒绝」;同一轮里跑完的那张不转', async () => {
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
        agentWorking
        onStop={() => undefined}
        stopping={false}
        onLoadOlder={async () => undefined}
      />,
    )
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    // 跑着的一轮里连着的两条调用收成一组(owner 10-16),卡在组里 —— 先点开那一组。
    const group = harness.container.querySelector('[data-slot="turn-process"] [data-slot="tool-group-root"] [data-slot="tool-group-root"] [data-slot="tool-group-trigger"]')
    expect(group, 'the two calls are not grouped inside the live turn').not.toBeNull()
    await act(async () => { (group as HTMLElement).click() })
    const card = (command: string) =>
      [...harness.container.querySelectorAll('[data-slot="tool-fallback-trigger"]')].find((trigger) => trigger.textContent?.includes(command))
    const loading = (command: string) =>
      card(command)?.querySelector('[data-testid="loading-indicator"]') != null
    // 阳控:两张卡都画出来了(否则「没有按钮」也可能是什么都没画)。
    expect(card('mkdir out'), 'the settled card').toBeDefined()
    expect(card('sleep 300'), 'the running card').toBeDefined()
    expect(harness.container.querySelectorAll('[data-slot="tool-fallback-approval"]').length, 'no allow / deny anywhere').toBe(0)
    expect(loading('sleep 300'), 'the running tool shows the shared loading animation').toBe(true)
    expect(loading('mkdir out'), 'the settled one has no loading animation').toBe(false)
  })
})
