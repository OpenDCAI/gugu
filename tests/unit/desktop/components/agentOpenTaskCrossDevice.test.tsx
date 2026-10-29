// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { presentationOfDisplayStatus } from '../../../support/agentDisplayStatusTestDouble'

/**
 * The DM header's 「在任务中打开」: the agent's session may live on this computer or on another machine of the account.
 * Before, only this computer's mapping was asked, so an agent on another machine got no button. Now the session comes from
 * this computer's mapping or the session directory (another machine, online), and both open through the one gugu link.
 */
const state = vi.hoisted(() => ({
  local: null as string | null,
  row: null as { deviceId: string; session: { conversationId: string } } | null,
  online: true,
}))
const followLink = vi.hoisted(() => vi.fn(() => true))
vi.mock('../../../../apps/desktop/src/lib/guguLinks', () => ({ followLink }))
vi.mock('../../../../apps/desktop/src/hooks/useSessionpageAgentProjection', () => ({
  useSessionpageAgentProjection: () => (state.local
    ? { kind: 'mapped', error: null, agentUserId: 'agent-1', context: { projectId: 'p', sessionId: state.local, platformRecovery: null, projectionError: null } }
    : { kind: 'unmapped', error: null, context: null, agentUserId: 'agent-1' }),
}))
vi.mock('@/mobile/agent-watch/useAgentSessionRow', () => ({ useAgentSessionRow: () => state.row }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: [{ device_id: 'server-b', is_online: state.online }] }),
}))
vi.mock('../../../../apps/desktop/src/hooks/useRemoteAgentQuestion', () => ({ useRemoteAgentQuestion: () => ({ question: null, key: null, available: false, respond: vi.fn() }) }))
vi.mock('../../../../apps/desktop/src/components/toastContext', () => ({ useToast: () => ({ toast: vi.fn() }) }))
const { useAgentSessionpagePresentation } = await import('../../../../apps/desktop/src/components/chat/AgentSessionpagePresentation')

const chat = {
  id: 'chat-agent', kind: 'ai', status: 'active', name: '', peer_user_id: 'agent-1', created_at: '',
  last_message_at: null, last_message_preview: null, unread_count: 0, pinned_message_id: null, last_read_seq: 0, next_message_seq: 1,
} satisfies ChatItem
function Probe() {
  const { openAction } = useAgentSessionpagePresentation(chat, { display_name: 'B', avatar: null },
    { status: 'idle', presentation: presentationOfDisplayStatus('idle'), runningActivity: null, local: null }, false, undefined)
  return <div>{openAction}</div>
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); followLink.mockClear(); state.local = null; state.row = null; state.online = true })
afterEach(() => harness.cleanup())
const button = () => harness.container.querySelector<HTMLButtonElement>('[data-testid="agent-open-task"]')

it('an agent on another machine that is online gets the button, and it opens that session through the gugu link', async () => {
  state.row = { deviceId: 'server-b', session: { conversationId: 'remote-conv' } }
  await harness.render(createNode(Probe, {}))
  expect(button()).not.toBeNull()
  await act(async () => { button()!.click() })
  expect(followLink).toHaveBeenCalledExactlyOnceWith({ kind: 'session', sessionId: 'remote-conv' })
})

it('a session on a machine that is offline (only its heartbeat digest) gets no button', async () => {
  state.row = { deviceId: 'server-b', session: { conversationId: 'remote-conv' } }
  state.online = false
  await harness.render(createNode(Probe, {}))
  expect(button()).toBeNull()
})

it('[positive control] an agent on this computer opens its own session through the same link', async () => {
  state.local = 'local-conv'
  await harness.render(createNode(Probe, {}))
  await act(async () => { button()!.click() })
  expect(followLink).toHaveBeenCalledExactlyOnceWith({ kind: 'session', sessionId: 'local-conv' })
})
