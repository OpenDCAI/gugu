// @vitest-environment jsdom
import { act, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { chat, clickElement, createReactHarness, displayIdentity, message, renderWithAppProviders } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'
import { emptyAgentWatchTimeline } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'

const probe = vi.hoisted(() => ({ props: null as unknown, read: vi.fn() }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDmSession', () => ({ useAgentDmSession: () => ({ session: { state: 'no-session' } }) }))
vi.mock('../../../../apps/desktop/src/components/chat/useConversationOptions', () => ({ useConversationOptions: () => ({ props: {}, confirmation: null, steers: false }) }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({ useAgentDisplayStatus: () => ({ status: null }) }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/use-timeline-session', () => ({ useTimelineSession: (...args: unknown[]) => {
  probe.read(...args)
  return { timeline: emptyAgentWatchTimeline(), phase: 'idle', respondingItemId: null, actionError: null }
} }))
vi.mock('../../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: (props: { turns: TranscriptTurn[]; composerContent: ReactNode }) => {
  probe.props = props
  return createElement('div', { 'data-shared-transcript': '' }, props.turns.flatMap(turn => turn.items.map(item => 'text' in item ? item.text : '')).join('\n'), props.composerContent)
} }))
import { AgentDmConversation } from '../../../../apps/desktop/src/components/chat/AgentDmConversation'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); probe.read.mockClear(); vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
const dm = chat({ id: 'external-dm', kind: 'ai', peer_user_id: 'external-agent', name: 'External agent' })
const received = message({ id: 'received', chat_id: dm.id, sender_user_id: 'external-agent', is_mine: false, content: '外部 agent 的已有回复。' })
it('shows authorized external DM history in the shared view, without reading a private session or blocking the composer', async () => {
  const sendMessage = vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined)
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: dm, shown: true }), { chat: {
    activeChat: dm, activeChatId: dm.id, messages: [received], identitiesById: { 'external-agent': displayIdentity('external-agent', { type: 'agent', display_name: 'External agent' }) }, sendMessage,
  } })
  expect(harness.container.textContent).toContain(received.content)
  expect(harness.container.textContent).not.toContain('没有会话')
  expect(probe.read.mock.calls.at(-1)?.slice(2)).toEqual([null, null, false])
  const props = probe.props as { activeTurnId: string | null }
  expect(props.activeTurnId).toBeNull()
  const editor = harness.container.querySelector<HTMLElement>('[contenteditable="true"]')!
  expect(editor).not.toBeNull()
  await act(async () => writeComposer(editor, '发给外部 agent 的一条消息'))
  await clickElement(harness.container.querySelector<HTMLElement>('button[aria-label="发送消息"]')!)
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1))
  expect(sendMessage.mock.calls[0]?.[0]).toBe('发给外部 agent 的一条消息')
})
it('does not mark a hidden DM read even if an old visibility callback arrives', async () => {
  const markMessageVisible = vi.fn()
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: dm, shown: false }), { chat: { activeChat: dm, activeChatId: dm.id, messages: [received], markMessageVisible } })
  const props = probe.props as { onVisibleItems: (ids: string[]) => void }
  props.onVisibleItems([received.id])
  expect(markMessageVisible).not.toHaveBeenCalled()
})
