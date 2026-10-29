// @vitest-environment jsdom
import { act, createElement, useEffect, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentDmSession } from '../../../../apps/desktop/src/hooks/useAgentDmSession'
import type { ChatCommands } from '@gugu/session-chat-ui'
import { openMessageSender } from '../../../../apps/desktop/src/lib/openMessageSender'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { chat, clickElement, contact, createReactHarness, displayIdentity, message, renderWithAppProviders } from '../../../support/testHarness'
import { writeComposer } from '../../../support/composerEditor'
import { emptyAgentWatchTimeline } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import { turnFailureMarker } from '@gugu/core/shared/ui/systemNotice'
import { dmRecord } from '../../../../apps/desktop/src/components/chat/agent-dm-record'

const probe = vi.hoisted(() => ({ props: null as unknown, read: vi.fn(), find: vi.fn(), scrollToItem: vi.fn(), setScrollMode: vi.fn(), fail: false, session: { state: 'no-session' } as AgentDmSession, turns: [] as TranscriptTurn[], settlements: {} as ReturnType<typeof emptyAgentWatchTimeline>['settlements'], respond: vi.fn() }))
const mobileShell = vi.hoisted(() => ({ enabled: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => mobileShell.enabled }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDmSession', () => ({ useAgentDmSession: () => ({ session: probe.session }) }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => import('../../../support/agentDisplayStatusTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/chat', () => import('../../../support/contactsChatServiceTestDouble'))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/use-timeline-session', () => ({ useTimelineSession: (...args: unknown[]) => {
  probe.read(...args)
  return { timeline: { ...emptyAgentWatchTimeline(), turns: probe.turns, settlements: probe.settlements }, phase: 'idle', respondingItemId: null, actionError: null, respond: probe.respond }
} }))
vi.mock('../../../../apps/desktop/src/components/assistant-ui/session-transcript-view.aui', () => ({ SessionTranscriptView: (props: { turns: TranscriptTurn[]; composerContent: ReactNode; onReady?: (view: unknown) => void }) => {
  if (probe.fail) throw new Error('Conversation render failure')
  probe.props = props
  const { onReady } = props
  useEffect(() => { onReady?.({ find: probe.find, scrollToItem: probe.scrollToItem, setScrollMode: probe.setScrollMode }) }, [onReady])
  return createElement('div', { 'data-shared-transcript': '' }, props.turns.flatMap(turn => turn.items.map(item => 'text' in item ? item.text : '')).join('\n'), props.composerContent)
} }))
import { AgentDmConversation } from '../../../../apps/desktop/src/components/chat/AgentDmConversation'
import { ContactsPanel } from '../../../../apps/desktop/src/components/ContactsPanel'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { ShellErrorBoundary } from '../../../../apps/desktop/src/components/ShellErrorBoundary'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
let harness: ReturnType<typeof createReactHarness>
let intersections: { target: Element; notify: (visible: boolean) => void }[]
beforeEach(() => { harness = createReactHarness(); probe.fail = false; probe.session = { state: 'no-session' }; probe.turns = []; probe.read.mockClear(); probe.find.mockClear(); probe.scrollToItem.mockClear(); probe.setScrollMode.mockClear(); probe.settlements = {}; probe.respond.mockReset(); intersections = []; vi.stubGlobal('IntersectionObserver', class {
  constructor(private callback: IntersectionObserverCallback) {}
  observe(target: Element) {
    const notify = (visible: boolean) => this.callback([{ target, isIntersecting: visible, intersectionRect: { width: visible ? 900 : 0, height: visible ? 850 : 0 } } as IntersectionObserverEntry], this as unknown as IntersectionObserver)
    intersections.push({ target, notify }); notify(true)
  }
  unobserve() {} disconnect() {}
}) })
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
  const props = probe.props as { activeTurnId: string | null; commands: ChatCommands }
  expect(props.commands.onOpenSender).toBe(openMessageSender)
  expect(props.commands.conversationAgentSession?.()).toBeNull()
  expect(props.commands.conversationAgentUserId?.()).toBe('external-agent')
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
  const setFollowingTail = vi.fn()
  await renderWithAppProviders(harness, createElement(ChatAreaPanel, { activeTab: 'chats' }), { chat: {
    activeChat: dm, activeChatId: dm.id, messages: [received], identitiesById: { 'external-agent': displayIdentity('external-agent', { type: 'agent' }) }, setFollowingTail,
  } })
  const transcript = probe.props as { onAtBottomChange: (atBottom: boolean) => void; onVisibleItems: (ids: string[]) => void }
  transcript.onAtBottomChange(true)
  expect(setFollowingTail, 'tail geometry does not acknowledge unseen replies').toHaveBeenLastCalledWith(false)
  transcript.onVisibleItems([received.id])
  expect(setFollowingTail).toHaveBeenLastCalledWith(true)
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

it('opens at the first unread and does not let a transient tail frame read the hidden backlog', async () => {
  const rows = Array.from({ length: 8 }, (_, index) => message({ id: `reply-${index}`, seq: index + 1, chat_id: dm.id, is_mine: false }))
  const markMessageVisible = vi.fn(), setFollowingTail = vi.fn()
  const unread = { ...dm, unread_count: 8, last_read_seq: 0, unread_locator: { message_id: rows[0].id, message_seq: 1, cursor_seq: 0 } } as typeof dm
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: unread, shown: true }), { chat: {
    activeChat: unread, activeChatId: dm.id, messages: rows, markMessageVisible, setFollowingTail,
  } })
  expect(probe.setScrollMode).toHaveBeenCalledWith({ kind: 'anchor', itemId: rows[0].id, edge: 'top', offset: -8 })
  const props = probe.props as { onAtBottomChange: (atBottom: boolean) => void; onVisibleItems: (ids: string[]) => void }
  props.onAtBottomChange(true)
  props.onVisibleItems(rows.slice(5).map(row => row.id))
  expect(markMessageVisible).not.toHaveBeenCalled()
  expect(setFollowingTail).toHaveBeenLastCalledWith(false)
  props.onVisibleItems(rows.slice(0, 2).map(row => row.id))
  expect(markMessageVisible.mock.calls.map(([row]) => row.id)).toEqual(rows.slice(0, 2).map(row => row.id))
})

it('does not block later visible replies when the first unread has no transcript item', async () => {
  probe.session = { state: 'ready', deviceId: 'own-device', sessionId: 'own-session', local: false }
  const first = { ...received, id: 'unprojected', seq: 1 }
  const next = { ...received, id: 'visible', seq: 2 }
  probe.turns = dmRecord([next], {})
  const markMessageVisible = vi.fn()
  const unread = { ...dm, last_read_seq: 0, unread_locator: { message_id: first.id, message_seq: 1, cursor_seq: 0 } } as typeof dm
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: unread, shown: true }), { chat: {
    activeChat: unread, activeChatId: dm.id, messages: [first, next], markMessageVisible,
  } })
  const props = probe.props as { onVisibleItems: (ids: string[]) => void }
  props.onVisibleItems([next.id])
  expect(markMessageVisible.mock.calls.map(([row]) => row.id)).toEqual([next.id])
})

it('retries resting visibility until acknowledged and uses the newer chat cursor', async () => {
  const old = { ...received, id: 'previously-read', seq: 1 }
  const next = { ...received, id: 'first-unread', seq: 3 }
  const unread = { ...dm, last_read_seq: 2, unread_locator: { message_id: next.id, message_seq: 3, cursor_seq: 0 } } as typeof dm
  const markMessageVisible = vi.fn()
  const render = (chat: typeof dm) => renderWithAppProviders(harness, createElement(AgentDmConversation, { chat, shown: true, mobile: true }), { chat: {
    activeChat: chat, activeChatId: dm.id, messages: [old, next], markMessageVisible,
  } })
  await render(unread)
  const visible = () => (probe.props as { onVisibleItems: (ids: string[]) => void }).onVisibleItems([next.id])
  visible() // The store is not yet ready to accept this first report.
  visible() // A resting viewport must be able to report it again.
  expect(markMessageVisible.mock.calls.map(([row]) => row.id)).toEqual([next.id, next.id])
  await render({ ...unread, last_read_seq: 3 })
  markMessageVisible.mockClear()
  visible()
  expect(markMessageVisible).not.toHaveBeenCalled()
})

it('keeps the DM model and entry anchor when its readable session arrives after IM visibility', async () => {
  const id = 'c411fbd9-251e-4636-906e-0a7b30460053'
  const first = { ...received, id, seq: 1 }
  const unread = { ...dm, last_read_seq: 0, unread_locator: { message_id: id, message_seq: 1, cursor_seq: 0 } } as typeof dm
  const render = (chat: typeof dm) => renderWithAppProviders(harness, createElement(AgentDmConversation, { chat, shown: true }), { chat: {
    activeChat: chat, activeChatId: dm.id, messages: [first], markMessageVisible: vi.fn(),
  } })
  probe.session = { state: 'resolving' }
  await render(unread)
  const before = probe.props as { uri: string; onVisibleItems: (ids: string[]) => void }
  before.onVisibleItems([id])
  probe.setScrollMode.mockClear()
  probe.session = { state: 'ready', deviceId: 'own-device', sessionId: 'own-session', local: false }
  probe.turns = [{ id: 'provider-turn', seq: 1, initiator: 'agent', outcome: { kind: 'done' }, items: [{
    kind: 'mcp-tool-call', id: 'provider-send', seq: 1, toolCallId: 'send', server: 'plugin_gugu-product_gugu', tool: 'message_send', title: 'Send', status: 'done',
    rawInput: JSON.stringify({ chat_id: dm.id, text: first.content }), outputText: `sent (id=msg:${id})`,
  }] }]
  // The opening IM view already confirmed the entry. Resolving a session is
  // enrichment of this same DM, not another activation with a fresh locator.
  await render({ ...unread, last_read_seq: 1, unread_locator: null })
  expect((probe.props as { uri: string }).uri).toBe(before.uri)
  expect(probe.setScrollMode).toHaveBeenCalledWith({ kind: 'anchor', itemId: `provider-send:sent:${id}`, edge: 'top', offset: -8 })
})

it('does not wait forever for a first unread that an anchor load confirms is unavailable', async () => {
  const next = { ...received, id: 'visible', seq: 2 }
  const markMessageVisible = vi.fn(), loadMessageAnchor = vi.fn(async () => {})
  const unread = { ...dm, last_read_seq: 0, unread_locator: { message_id: 'missing', message_seq: 1, cursor_seq: 0 } } as typeof dm
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: unread, shown: true }), { chat: {
    activeChat: unread, activeChatId: dm.id, messages: [next], markMessageVisible, loadMessageAnchor,
  } })
  await vi.waitFor(() => expect(loadMessageAnchor).toHaveBeenCalledWith('missing'))
  const props = probe.props as { onVisibleItems: (ids: string[]) => void }
  props.onVisibleItems([next.id])
  expect(markMessageVisible.mock.calls.map(([row]) => row.id)).toEqual([next.id])
})

it('binds an owned agent name to its real readable session, keeping the user identity distinct', async () => {
  probe.session = { state: 'ready', deviceId: 'own-device', sessionId: 'own-session', local: false }
  const own = chat({ id: 'own-dm', kind: 'ai', peer_user_id: 'own-agent' })
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: own, shown: true }), { chat: {
    activeChat: own, activeChatId: own.id, messages: [],
  } })
  const { commands } = probe.props as { commands: ChatCommands }
  expect(commands.onOpenSender).toBe(openMessageSender)
  expect(commands.conversationAgentSession?.()).toBe('own-session')
  expect(commands.conversationAgentUserId?.()).toBe('own-agent')
})

it('uses the project approval labels and the same settlement when approving from a DM', async () => {
  probe.settlements = { write: { itemId: 'write', kind: 'permission', state: 'pending', title: 'Write proof.txt', options: [
    { optionId: 'yes', name: 'Yes', kind: 'allow_once' }, { optionId: 'no', name: 'No', kind: 'reject_once' },
  ] } as unknown as ReturnType<typeof emptyAgentWatchTimeline>['settlements'][string] }
  probe.respond.mockResolvedValue({ accepted: true })
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: dm, shown: true }), { chat: { activeChat: dm, activeChatId: dm.id } })
  const band = harness.container.querySelector('[data-testid="agent-sessionpage-permission"]')!
  expect(band.textContent).toContain('等待批准')
  expect(band.textContent).not.toContain('Yes')
  const allow = [...band.querySelectorAll('button')].find(button => button.textContent?.includes('允许这次'))!
  await clickElement(allow)
  expect(probe.respond).toHaveBeenCalledWith({ itemId: 'write', kind: 'permission', optionId: 'yes' })
})

it('shows the retained-message notice until the peer replies, without losing it to a later owner prompt', async () => {
  const notice = message({ id: 'retained', seq: 2, chat_id: dm.id, content_type: 'system', sender_user_id: dm.peer_user_id,
    client_message_id: turnFailureMarker('retained', 'notAdmitted'), content: '消息已保留，助理就绪后回复。' })
  const owner = message({ id: 'next-question', seq: 3, chat_id: dm.id, is_mine: true, sender_user_id: 'owner' })
  const draw = (messages: typeof notice[]) => renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: dm, shown: true }), { chat: { activeChat: dm, activeChatId: dm.id, messages } })
  await draw([notice, owner])
  const before = probe.props as { commands: ChatCommands; turns: TranscriptTurn[] }
  expect(before.commands.conversationProcessNotice?.('im:retained:process')).toEqual({ id: notice.id, text: notice.content })
  expect(before.turns.some(turn => turn.id === 'im:retained')).toBe(true)
  await draw([notice, owner, { ...received, seq: 4 }])
  const after = probe.props as { commands: ChatCommands; turns: TranscriptTurn[] }
  expect(after.commands.conversationProcessNotice?.('im:retained:process')).toBeNull()
  expect(after.turns.some(turn => turn.id === 'im:retained')).toBe(false)
})


it('captures unread on return to a retained desktop slot even when its logical shown prop stays true', async () => {
  const rows = Array.from({ length: 10 }, (_, index) => message({ id: `hidden-reply-${index}`, seq: index + 2, chat_id: dm.id, is_mine: false }))
  const own = message({ id: 'own-prompt', seq: 1, chat_id: dm.id, is_mine: true })
  const markMessageVisible = vi.fn()
  const draw = (chat: typeof dm, messages: typeof rows) => renderWithAppProviders(harness, createElement(AgentDmConversation, { chat, shown: true }), { chat: {
    activeChat: chat, activeChatId: dm.id, messages, markMessageVisible,
  } })
  await draw({ ...dm, last_read_seq: 1, unread_locator: null }, [own])
  const surface = () => intersections.find(entry => entry.target.getAttribute('data-testid') === 'agent-dm-conversation')
  await act(async () => surface()?.notify(false)) // Contacts covers the retained task/chat slot.
  const unread = { ...dm, last_read_seq: 1, unread_locator: { message_id: rows[0].id, message_seq: 2, cursor_seq: 1 } } as typeof dm
  await draw(unread, [own, ...rows])
  probe.setScrollMode.mockClear()
  await act(async () => surface()?.notify(true)) // Messages → Conversations → same existing tab.
  expect(probe.setScrollMode).toHaveBeenCalledWith({ kind: 'anchor', itemId: rows[0].id, edge: 'top', offset: -8 })
  const visible = (probe.props as { onVisibleItems: (ids: string[]) => void }).onVisibleItems
  visible(rows.slice(5).map(row => row.id))
  expect(markMessageVisible).not.toHaveBeenCalled()
  visible(rows.slice(0, 3).map(row => row.id))
  expect(markMessageVisible.mock.calls.map(([row]) => row.id)).toEqual(rows.slice(0, 3).map(row => row.id))
  await draw({ ...dm, last_read_seq: 11, unread_locator: null }, [own, ...rows])
  await act(async () => surface()?.notify(false))
  const second = rows.map((row, index) => ({ ...row, id: `second-reply-${index}`, seq: index + 13 }))
  const nextEntry = { ...dm, last_read_seq: 12, unread_locator: { message_id: second[0].id, message_seq: 13, cursor_seq: 12 } } as typeof dm
  await draw(nextEntry, [own, ...rows, ...second])
  probe.setScrollMode.mockClear(); markMessageVisible.mockClear()
  await act(async () => surface()?.notify(true))
  expect(probe.setScrollMode).toHaveBeenCalledWith({ kind: 'anchor', itemId: second[0].id, edge: 'top', offset: -8 })
  ;(probe.props as { onVisibleItems: (ids: string[]) => void }).onVisibleItems(second.slice(0, 2).map(row => row.id))
  expect(markMessageVisible.mock.calls.map(([row]) => row.id)).toEqual(second.slice(0, 2).map(row => row.id))
})

const selectionRoots: HTMLElement[] = []
beforeEach(() => { mobileShell.enabled = false })
afterEach(() => { selectionRoots.splice(0).forEach(root => root.remove()); window.getSelection()?.removeAllRanges() })
function excerptRoot(item: import('@gugu/session-chat-ui').ChatMessage) {
  const root = document.createElement('div'); root.innerHTML = '<p>Beta</p>'
  document.body.append(root); selectionRoots.push(root)
  const commands = (probe.props as { commands: ChatCommands }).commands
  expect(commands.onMessageTextMount).toBeTypeOf('function')
  commands.onMessageTextMount!({ root, itemId: item.id, message: () => item })
  return root
}
async function selectExcerpt(root: HTMLElement) {
  const range = document.createRange(); range.selectNodeContents(root.querySelector('p')!)
  await act(async () => {
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range)
    document.dispatchEvent(new Event('selectionchange')); document.dispatchEvent(new Event('touchend'))
  })
}
it('sends a mobile excerpt from the unified transcript through the existing composer with its IM source', async () => {
  mobileShell.enabled = true
  const source = { ...received, content: 'Alpha Beta' }
  const sendMessage = vi.fn(async (_text: string, _options?: unknown) => undefined)
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: dm, shown: true, mobile: true }), { chat: {
    activeChat: dm, activeChatId: dm.id, messages: [source], identitiesById: { 'external-agent': displayIdentity('external-agent', { display_name: 'Ada' }) }, sendMessage,
  } })
  const editor = harness.container.querySelector<HTMLElement>('[contenteditable="true"]')!
  editor.blur()
  await selectExcerpt(excerptRoot({ kind: 'message', id: source.id, role: 'assistant', text: source.content }))
  expect(document.activeElement).not.toBe(editor)
  expect(harness.container.querySelector('button[aria-label="取消引用"]')?.parentElement?.textContent).toContain('Beta')
  await act(async () => writeComposer(editor, 'Explain'))
  await clickElement(harness.container.querySelector<HTMLElement>('button[aria-label="发送消息"]')!)
  await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledOnce())
  expect(sendMessage.mock.calls[0]).toEqual([expect.stringMatching(/^> \[Ada\]: Beta\n\nExplain$/), expect.objectContaining({ replyToMessageId: source.id })])
})
it('resets quote state and old row listeners when the keyed DM host changes chat', async () => {
  mobileShell.enabled = true
  const source = { ...received, content: 'Alpha Beta' }
  const options = { chat: { activeChat: dm, activeChatId: dm.id, messages: [source] } }
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: dm, shown: true, mobile: true }), options)
  const old = excerptRoot({ kind: 'message', id: source.id, role: 'assistant', text: source.content })
  await selectExcerpt(old)
  expect(harness.container.querySelector('button[aria-label="取消引用"]')).not.toBeNull()
  const next = { ...dm, id: 'different-dm' }
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: next, shown: true, mobile: true }), { chat: { activeChat: next, activeChatId: next.id, messages: [] } })
  await selectExcerpt(old)
  expect(harness.container.querySelector('button[aria-label="取消引用"]')).toBeNull()
  expect((probe.props as { uri: string }).uri).toBe('dm:different-dm')
})
it('leaves desktop selection commands unchanged on the unified DM host', async () => {
  await renderWithAppProviders(harness, createElement(AgentDmConversation, { chat: dm, shown: true }), { chat: { activeChat: dm, activeChatId: dm.id, messages: [received] } })
  expect((probe.props as { commands: ChatCommands }).commands.onMessageTextMount).toBeUndefined()
})
