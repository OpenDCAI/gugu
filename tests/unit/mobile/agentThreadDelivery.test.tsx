// @vitest-environment jsdom
//
// 2026-09-29 手机实测:子会话回给父会话的那句(route="session-direct")在会话页里是一个用户气泡,里面整段
// <gugu_delivery …> XML。桌面会话页同一行折成投递卡;手机只认 chat 路由,其余原样当用户消息画。
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

const envelope = (route: string) =>
  `<gugu_delivery route="${route}" from="ChildBxc" from_id="session:a744d00d" msg="msg:8ef7b4d2" at="2026-09-29 01:31 北京时间"><![CDATA[Hi!]]><arrival>Sent to you through 咕咕; reply with session_message.</arrival></gugu_delivery>`

const turns = (text: string): TranscriptTurn[] => [{
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text },
    { kind: 'message', id: 'a1', seq: 1, role: 'assistant', text: 'ChildBxc replied Hi!' },
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

async function show(text: string) {
  await harness.render(
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns: turns(text) }}
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
    />,
  )
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
}

const deliverySlots = () => harness.container.querySelectorAll('[data-testid="mobile-delivery-message"]').length
const userBubbles = () => [...harness.container.querySelectorAll('[data-role="user"]:not([data-testid="mobile-delivery-message"])')].map((el) => el.textContent ?? '')

describe('手机任务页的投递与桌面同一个判据', () => {
  it('session-direct 投递进投递卡,❌ 用户气泡里露出整段 XML', async () => {
    await show(envelope('session-direct'))
    expect(deliverySlots()).toBe(1)
    expect(userBubbles().some((text) => text.includes('<gugu_delivery'))).toBe(false)
  })

  it('正对照:chat 路由本来就进投递卡', async () => {
    await show(envelope('chat'))
    expect(deliverySlots()).toBe(1)
  })

  // #6822 harness 把排着队的两条并成一条输入时,读方按一批读:仍是投递卡,❌ 一坨裸 XML。
  it('两条信封首尾相接也进投递卡', async () => {
    await show(`${envelope('chat')}\n${envelope('session-direct')}`)
    expect(deliverySlots()).toBe(1)
    expect(userBubbles().some((text) => text.includes('<gugu_delivery'))).toBe(false)
  })
})
