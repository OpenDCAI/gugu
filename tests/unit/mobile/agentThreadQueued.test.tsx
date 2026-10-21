// @vitest-environment jsdom
//
// 2026-10-03 手机实测(mac1 + 安卓模拟器):agent 忙时从手机发一句,离开会话页再回来,那句就从手机上消失了,
// 而桌面「Queued prompts (1)」一直在。排着的那句现在由那台机器的队列画(时间线的 queuedPrompts)。
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

const QUEUED = 'QUEUED-ACP-7731 reply with exactly: GOT-7731'

const running: TranscriptTurn[] = [{
  id: 't1',
  seq: 1,
  initiator: 'user',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'run sleep 120' },
    { kind: 'message', id: 'a1', seq: 1, role: 'assistant', text: 'sleeping' },
  ],
}] as unknown as TranscriptTurn[]

const pickedUp: TranscriptTurn[] = [
  ...running,
  {
    id: 't2',
    seq: 2,
    initiator: 'user',
    items: [
      { kind: 'message', id: 'u2', seq: 0, role: 'user', text: QUEUED },
      { kind: 'message', id: 'a2', seq: 1, role: 'assistant', text: 'GOT-7731' },
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

async function show(turns: TranscriptTurn[], queuedPrompts: { id: string; text: string }[]) {
  await harness.render(
    <AgentThread
      timeline={{ ...emptyAgentWatchTimeline(), turns, queuedPrompts }}
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
}

const userBubbles = () => [...harness.container.querySelectorAll('[data-role="user"]')].map((el) => el.textContent ?? '')

describe('手机任务页的排队提示', () => {
  it('那台机器上排着的那句画在时间线末尾:重新进页时拿到的就是这一份', async () => {
    await show(running, [{ id: 'qp-1', text: QUEUED }])
    expect(userBubbles().filter((text) => text.includes(QUEUED))).toHaveLength(1)
  })

  it('阴控:队列空着就没有这个气泡', async () => {
    await show(running, [])
    expect(userBubbles().some((text) => text.includes(QUEUED))).toBe(false)
  })

  // 运行时仓库里有没有兄弟(「‹ 2/2 ›」的来源)由 agentThreadOneRowPerMessage6901 的探针读 branchCount,第 7、8 格是排队的次序。
  it('被 agent 接走:排着的离队、记录里那条用户消息顶上 —— 只剩一个气泡', async () => {
    await show(running, [{ id: 'qp-1', text: QUEUED }])
    await show(pickedUp, [])
    expect(userBubbles().filter((text) => text.includes(QUEUED))).toHaveLength(1)
  })
})
