// @vitest-environment jsdom
//
// #7305:附件卡等这一轮跑完或被停下才挂。手机上「这一轮还没结算」不只是在跑 —— 等审批 / 提问时
// 页面的 attention 是 'waiting'(agentWorking=false),这一轮照样没结算,卡也不该挂(同桌面的活动层)。
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

const openCall = {
  kind: 'mcp-tool-call',
  id: 'o1',
  seq: 1,
  toolCallId: 'o1',
  title: 'mcp__gugu__session_open_in_tab',
  server: 'gugu',
  tool: 'session_open_in_tab',
  status: 'done',
  rawInput: JSON.stringify({ path: '/r/report.html' }),
  outputText: JSON.stringify({ opened: true, path: '/r/report.html', intent: 'pinned' }),
  parentToolCallId: null,
}
const turnWith = (outcome: TranscriptTurn['outcome']) =>
  [
    {
      id: 't1', seq: 1, initiator: 'user', ...(outcome ? { outcome } : {}),
      items: [{ kind: 'message', id: 'u1', seq: 0, role: 'user', text: '做个汇报' }, openCall],
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

async function cardGroups(turns: TranscriptTurn[]) {
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
      // 等审批:attention 是 'waiting',页面传下来的是 false
      agentWorking={false}
      headerRunning={false}
      onStop={() => undefined}
      stopping={false}
      onLoadOlder={async () => undefined}
    />,
  )
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  return harness.container.querySelectorAll('[data-testid="mobile-opened-outputs"]').length
}

describe('手机附件卡:这一轮没结算就不挂,哪怕页面说的是「在等」不是「在跑」', () => {
  it('等审批的这一轮(没有 outcome):没有卡', async () => {
    expect(await cardGroups(turnWith(undefined))).toBe(0)
  })

  it('同一轮结算之后:卡挂上(阳控:这台仪器认得出卡)', async () => {
    expect(await cardGroups(turnWith({ kind: 'done' }))).toBe(1)
  })
})
