// @vitest-environment jsdom
import { act, createElement, useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { chat, clickElement, contact, createReactHarness, displayIdentity, message, renderWithAppProviders } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'
import { emptyAgentWatchTimeline } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'

const probe = vi.hoisted(() => ({ props: null as unknown, read: vi.fn(), find: vi.fn(), fail: false }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDmSession', () => ({ useAgentDmSession: () => ({ session: { state: 'no-session' } }) }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/use-timeline-session', () => ({ useTimelineSession: (...args: unknown[]) => {
  probe.read(...args)
  return { timeline: emptyAgentWatchTimeline(), phase: 'idle', respondingItemId: null, actionError: null }
} }))
vi.mock('../../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: (props: { turns: TranscriptTurn[]; composerContent: ReactNode; onReady?: (view: unknown) => void }) => {
  if (probe.fail) throw new Error('Conversation render failure')
  probe.props = props
  useEffect(() => { props.onReady?.({ find: probe.find }) }, [props.onReady])
  return createElement('div', { 'data-shared-transcript': '' }, props.turns.flatMap(turn => turn.items.map(item => 'text' in item ? item.text : '')).join('\n'), props.composerContent)
} }))
import { AgentDmConversation } from '../../../../apps/desktop/src/components/chat/AgentDmConversation'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { ShellErrorBoundary } from '../../../../apps/desktop/src/components/ShellErrorBoundary'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); probe.fail = false; probe.read.mockClear(); probe.find.mockClear(); vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} }) })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
const dm = chat({ id: 'external-dm', kind: 'ai', peer_user_id: 'external-agent', name: 'External agent' })
const received = message({ id: 'received', chat_id: dm.id, sender_user_id: 'external-agent', is_mine: false, content: '外部 agent 的已有回复。' })

async function openOwnedAgentFromContacts() {
  const own = contact({ id: 'my-agent', type: 'agent', display_name: 'My agent', owner_user_id: 'user-1', device_id: 'local-device' })
  function Entry() {
    const [opened, setOpened] = useState(false)
    return <ShellErrorBoundary><aside data-navigation=""><button onClick={() => setOpened(false)}>Contacts</button></aside>
      <main>{opened ? <ChatAreaPanel activeTab="chats" openNonce={0} /> : <ContactsPanel activeTab="contacts" onSwitchToChat={() => setOpened(true)} />}</main>
    </ShellErrorBoundary>
  }
  await renderWithAppProviders(harness, createElement(Entry), { auth: { id: 'user-1' }, contacts: { contacts: [own] }, chat: {
    activeChat: chat({ id: 'own-dm', kind: 'ai', peer_user_id: own.id }), activeChatId: 'own-dm', messages: [],
  } })
  const section = harness.container.querySelector('[data-testid="contacts-device-section"]')!
  await clickElement(section.querySelector<HTMLElement>('[data-slot="section-label"]')!)
  await clickElement(harness.container.querySelector<HTMLElement>('[data-contact-id="my-agent"]')!)
  const navigation = harness.container.querySelector('[data-navigation]')!
  await clickElement(harness.container.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.contactsDetailSendMessageButton}"]`)!)
  return navigation
}

it('opens Contacts → own agent → send message with the real session confirmation and composer providers', async () => {
  const navigation = await openOwnedAgentFromContacts()
  expect(harness.container.querySelector('[data-shared-transcript]')).not.toBeNull()
  expect(harness.container.querySelector('[contenteditable="true"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-navigation]')).toBe(navigation)
  expect(harness.container.querySelector('[role="alert"]')).toBeNull()
})

it('contains a conversation render failure inside its content while navigation stays usable', async () => {
  probe.fail = true
  const navigation = await openOwnedAgentFromContacts()
  expect(harness.container.querySelector('[data-testid="conversation-error-fallback"]')).not.toBeNull()
  expect(harness.container.querySelector('[data-testid="shell-error-fallback"]')).toBeNull()
  expect(harness.container.querySelector('[data-navigation]')).toBe(navigation)
  await clickElement(navigation.querySelector('button')!)
  expect(harness.container.querySelector('[data-testid="contacts-browse"]')).not.toBeNull()
})
it('shows authorized external DM history in the shared view, without reading a private session or blocking the composer', async () => {
  const sendMessage = vi.fn<(content: string) => Promise<string | undefined>>(async () => undefined)
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

it('routes the shared header search to the transcript find API and clears it on close', async () => {
  await renderWithAppProviders(harness, createElement(ChatAreaPanel, { activeTab: 'chats' }), { chat: {
    activeChat: dm, activeChatId: dm.id, messages: [received], identitiesById: { 'external-agent': displayIdentity('external-agent', { type: 'agent' }) },
  } })
  await clickElement(harness.container.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderMoreButton}"]`)!)
  await clickElement(document.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderSearchButton}"]`)!)
  const input = harness.container.querySelector<HTMLInputElement>(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderSearchInput}"]`)!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '已有回复')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  expect(probe.find).toHaveBeenLastCalledWith('已有回复')
  await clickElement(harness.container.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderSearchCancelButton}"]`)!)
  expect(probe.find).toHaveBeenLastCalledWith('')
})
