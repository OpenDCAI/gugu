// @vitest-environment jsdom
//
// 2026-10-02 手机实测:agent 一行一句写的 25 行诗在手机会话页并成一整段(<p> 里有 \n、0 个 <br>),
// 桌面会话页转录是 25 行 —— 转录按 TRANSCRIPT_DIALECT 读(hardBreaks),手机要同一种读法。
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

const POEM = 'The tide comes in on silver feet,\nand leaves behind a braided sheet\nof foam that whispers to the sand'

const turns = [{
  id: 't1',
  seq: 1,
  initiator: 'user',
  outcome: 'completed',
  items: [
    { kind: 'message', id: 'u1', seq: 0, role: 'user', text: 'write a poem' },
    { kind: 'message', id: 'a1', seq: 1, role: 'assistant', text: POEM },
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

describe('手机会话页的 agent 正文与桌面转录同一种换行读法', () => {
  it('段落里的单个换行画成换行', async () => {
    await harness.render(
      <AgentThread
        timeline={{ ...emptyAgentWatchTimeline(), turns }}
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
      />,
    )
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    const paragraph = [...harness.container.querySelectorAll('[data-role="assistant"] p')].find((p) => p.textContent?.includes('silver feet'))
    expect(paragraph, 'the reply paragraph was not rendered').toBeTruthy()
    expect(paragraph!.querySelectorAll('br').length).toBe(2)
  })
})
