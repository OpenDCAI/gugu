// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentDisplayStatus, GroupChatSettings } from '@gugu/core/shared/types/chat'
import { chatService } from '../../../apps/desktop/src/lib/chat'
// The task workspace's stores import each other in a cycle that only resolves when app-state loads first, as the app's
// own entry does; importing ChatListPanel alone would enter it through sidebar-store.
import '@renderer/lib/stores/app-state'
import { ChatListPanel, TopicSubRow } from '../../../apps/desktop/src/components/ChatListPanel'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { SidebarStore } from '@renderer/features/sidebar/sidebar-store'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../support/testHarness'

const state = vi.hoisted(() => ({ canDissolve: true, sessions: [] as SessionpageSessionSummary[], statuses: {} as Record<string, AgentDisplayStatus>, read: vi.fn(async (_input: { chats: { id: string }[] }) => ({ failedChats: 0 })), select: vi.fn(), open: vi.fn(async () => {}) }))
vi.mock('../../../apps/desktop/src/lib/chatUnreadLocator', async original => ({ ...await original<typeof import('../../../apps/desktop/src/lib/chatUnreadLocator')>(), markChatsReadAndRefresh: state.read }))
vi.mock('../../../apps/desktop/src/platform', () => import('../../support/capacitorPlatformTestDouble'))
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', async () => ({
  ...await import('../../support/agentDisplayStatusTestDouble'),
  useAgentDisplayStatuses: () => state.statuses,
}))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: [{ device_id: 'mac', is_online: true, projects: [{ localProjectId: 'local', name: 'Planning', createdAt: '2026-10-01', chatId: 'group', folders: [] }] }] }),
}))
vi.mock('../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async original => ({
  ...await original<typeof import('../../../apps/desktop/src/session/shared/remote-sessions/session-directory')>(),
  useLiveDeviceSessions: () => ({ mac: { projects: [], sessions: state.sessions, cached: false, loading: false, error: null } }),
}))
vi.mock('@renderer/lib/ipc', () => ({ events: { on: vi.fn() }, rpc: {}, onMachineEvent: () => () => undefined }))

// jsdom has no layout: give the document (the sidebar list's scroller here) a window's height, so the sidebar's
// virtualized conversation lines (@@@sidebar-chat-window) mount the lines that would fit, as on screen.
beforeEach(() => {
  for (const [key, value] of [['offsetHeight', 900], ['offsetWidth', 1024]] as const) Object.defineProperty(document.documentElement, key, { configurable: true, get: () => value })
})

let h: ReturnType<typeof createReactHarness>
beforeEach(() => {
  h = createReactHarness(); state.statuses = {}; state.sessions = []; state.canDissolve = true; vi.clearAllMocks()
  vi.spyOn(chatService, 'getGroupChatSettings').mockImplementation(async id => ({
    id, creator_user_id: 'user-1', name: 'Planning', status: 'active', group_prompt: null,
    default_agent_type: null, description: null, max_members: 100, allow_member_invite: false,
    invite_link_enabled: false, agent_join_approval: false, join_mode: 'approval', hide_history: false,
    avatar_url: null, is_discoverable: false, agent_flood_threshold: null, agent_flood_threshold_effective: 5,
    my_role: 'owner', can_manage: true, can_dissolve: state.canDissolve, can_archive_topic: false,
  } satisfies GroupChatSettings))
})
afterEach(() => { vi.useRealTimers(); h.cleanup() })
const source = chat({ id: 'group', kind: 'group', name: 'Planning', unread_count: 2, member_user_ids: ['task-agent'] })
const topic = chat({ id: 'task-topic', kind: 'topic', name: 'Fix login', source_chat_id: source.id, unread_count: 8 })
const orphan = chat({ id: 'orphan-topic', kind: 'topic', name: 'Older task', source_chat_id: 'archived', unread_count: 4 })
const render = (mobile: boolean, chats = [source, topic, orphan]) => renderWithAppProviders(h, createNode(ChatListPanel, { mobile, activeTab: 'chats', placement: mobile ? 'page' : 'sidebar' }), { chat: { chats, setActiveChatId: state.select, openUnreadChat: state.open }, contacts: {} })
const row = () => h.container.querySelector<HTMLElement>('[data-chat-row="group"]')!

it('phone shows one source row, aggregates topic unread before search, and updates after reading a topic', async () => {
  await render(true)
  expect([...h.container.querySelectorAll<HTMLElement>('[data-chat-row]')].map(el => el.dataset.chatRow)).toEqual(['group'])
  expect(row().textContent).toContain('10')
  expect(row().querySelectorAll('.gg-list-row-line')).toHaveLength(1)
  expect(row().querySelector('.gg-list-row-line .gg-list-row-trailing')?.textContent).toContain('10')
  expect(h.container.querySelector('[data-topic-subrow]')).toBeNull()
  await act(async () => { window.dispatchEvent(new CustomEvent('__open_phone_list_search', { detail: 'chats' })) })
  const search = h.container.querySelector<HTMLInputElement>('[data-header-search-field] input')!
  await typeInto(search, 'Planning')
  expect(row().textContent).toContain('10')
  await render(true, [source, { ...topic, unread_count: 0 }, orphan])
  expect(row().textContent).not.toContain('10')
  expect(row().querySelectorAll('.gg-list-row-line')).toHaveLength(1)
  expect(row().textContent).toContain('2')
  expect(source.unread_count).toBe(2)
})

it('desktop keeps the indented topic and separate unread counts', async () => {
  await render(false)
  expect(row().querySelectorAll('.gg-list-row-line')).toHaveLength(2)
  expect(h.container.querySelector('[data-topic-subrow="task-topic"]')?.textContent).toContain('8')
  expect(row().textContent).toContain('2')
  expect(row().textContent).not.toContain('10')
})

const task = (id: string, status: 'needs_user' | 'error' | 'working' | 'idle', unseen: boolean, projectId = 'local'): SessionpageSessionSummary => ({
  conversationId: id, projectId, title: id, harness: 'codex', runtime: 'acp', supported: true, unseen, lastInteractedAt: null,
  agentStatus: status, status: { status, detail: status === 'needs_user' ? 'approval' : null },
} as SessionpageSessionSummary)
/** The desktop project dot for the same host listing (SidebarStore's remote route). */
function desktopDot(sessions: readonly SessionpageSessionSummary[]): number {
  const project = { id: 'local', createdAt: '2026-10-01T00:00:00.000Z', mountedProject: { sessionManager: { sessions: new Map() } } }
  const store = new SidebarStore({ projects: new Map([['local', project]]) } as unknown as ConstructorParameters<typeof SidebarStore>[0])
  store.machines = { machineOf: () => 'mac', label: () => 'mac', homeDir: () => '/work', connected: () => true, sessionsOf: () => ({ live: true, sessions }), session: (_deviceId, id) => sessions.find(session => session.conversationId === id) ?? null }
  return store.needsYouCountForProject('local')
}

it.each([
  ['an unread failure', true, [task('f', 'error', true)]],
  ['a wait', true, [task('w', 'needs_user', false)]],
  ['only read failures, working and idle', false, [...Array.from({ length: 40 }, (_, i) => task(`old-${i}`, 'error', false)), task('run', 'working', true), task('rest', 'idle', true)]],
  ['attention in another project only', false, [task('elsewhere', 'needs_user', true, 'other')]],
] as const)('the phone project avatar badge and the desktop project dot agree: %s', async (_name, shown, sessions) => {
  state.sessions = [...sessions]
  // The agent's live status says nothing here: the badge reads the tasks, as the desktop dot does.
  state.statuses = { 'task-agent': 'needs_user' }
  await render(true)
  const badge = row().querySelector('[data-testid="phone-project-waiting"]') !== null
  expect(desktopDot(sessions) > 0).toBe(shown)
  expect(badge).toBe(shown)
})
it('desktop chat rows carry no phone project badge', async () => {
  state.sessions = [task('w', 'needs_user', true)]
  await render(false)
  expect(row().querySelector('[data-testid="phone-project-waiting"]')).toBeNull()
})

it('desktop Chats excludes independent tasks even when an older renderer has published them', async () => {
  const target = window as unknown as Record<string, unknown>
  target.__GUGU_SIDEBAR_SESSIONS__ = [{ projectId: 'task-home', sessionId: 'independent', title: 'Independent task', time: Date.now(), group: null, agentUserId: null }]
  try {
    await render(false)
    expect(h.container.querySelector('[data-chat-row="group"]')).not.toBeNull()
    expect(h.container.querySelector('[data-session-line="independent"]')).toBeNull()
    expect(h.container.textContent).not.toContain('Independent task')
  } finally {
    delete target.__GUGU_SIDEBAR_SESSIONS__
  }
})

const pointer = (target: Element, type: string, x = 20, pointerType = 'touch') => {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, { clientX: x, clientY: 40, pointerType })
  target.dispatchEvent(event)
}
async function hold(target: Element) {
  vi.useFakeTimers()
  await act(async () => { pointer(target, 'pointerdown'); vi.advanceTimersByTime(500) })
  const release = new Event('touchend', { bubbles: true, cancelable: true })
  await act(async () => { pointer(target, 'pointerup'); target.dispatchEvent(release) })
  expect(release.defaultPrevented).toBe(true)
  vi.useRealTimers()
}
const readAction = () => document.querySelector<HTMLElement>('[data-testid=conversation-row-mark-read]')!

it('phone group long-press reuses all row actions and marks only the group and descendants without opening it', async () => {
  await render(true)
  await hold(row())
  expect([...document.querySelectorAll('[role=menuitem]')].map(item => item.getAttribute('data-testid'))).toEqual([
    'conversation-row-mark-read', 'conversation-row-pin', 'conversation-row-notifications', 'chat-row-mark-all-read', 'conversation-row-delete-chat',
  ])
  expect(state.select).not.toHaveBeenCalled()
  expect(state.open).not.toHaveBeenCalled()
  await clickElement(readAction())
  expect(state.read).toHaveBeenCalledOnce()
  expect(state.read.mock.calls[0][0].chats.map(chat => chat.id)).toEqual(['group', 'task-topic'])
})

it('phone group long-press keeps personal actions but omits deletion when the server denies dissolution', async () => {
  state.canDissolve = false
  await render(true)
  await hold(row())
  expect(document.querySelector('[data-testid=conversation-row-delete-chat]')).toBeNull()
  expect(readAction()).not.toBeNull()
  expect(document.querySelector('[data-testid=conversation-row-pin]')).not.toBeNull()
  expect(state.select).not.toHaveBeenCalled()
})

it('phone topic long-press marks its own scope and leaves the parent unread', async () => {
  const clicked = vi.fn()
  await renderWithAppProviders(h, createNode(TopicSubRow, { topic, mobile: true, isActive: false, tabIndex: 0, actions: { activate: vi.fn(), openTopic: clicked, toggleTopics: vi.fn(), pin: vi.fn(), setNotificationLevel: vi.fn(), remove: vi.fn(), focus: vi.fn(), keyDown: vi.fn() } }), { chat: { chats: [source, topic, orphan] } })
  await hold(h.container.querySelector('[data-topic-subrow]')!)
  await clickElement(readAction())
  expect(state.read.mock.calls[0][0].chats.map(chat => chat.id)).toEqual(['task-topic'])
  expect(clicked).not.toHaveBeenCalled()
})

it('short tap and a cancelled scroll retain ordinary row behavior', async () => {
  await render(true)
  vi.useFakeTimers()
  await act(async () => {
    pointer(row(), 'pointerdown'); pointer(row(), 'pointerup'); vi.advanceTimersByTime(650)
    pointer(row(), 'pointerdown'); pointer(row(), 'pointermove', 30); vi.advanceTimersByTime(650)
  })
  expect(document.querySelector('[role=menu]')).toBeNull()
  const release = new Event('touchend', { bubbles: true, cancelable: true })
  row().dispatchEvent(release)
  expect(release.defaultPrevented).toBe(false)
  vi.useRealTimers()
  await clickElement(row())
  expect(state.select).toHaveBeenCalledWith('group')
  expect(state.read).not.toHaveBeenCalled()
})

it('desktop still opens by right click, with scoped read disabled when only other rows are unread', async () => {
  await render(false, [{ ...source, unread_count: 0 }, { ...topic, unread_count: 0 }, orphan])
  vi.useFakeTimers()
  await act(async () => { pointer(row(), 'pointerdown'); vi.advanceTimersByTime(650) })
  expect(document.querySelector('[role=menu]')).toBeNull()
  vi.useRealTimers()
  await act(async () => row().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 40 })))
  expect(readAction().getAttribute('aria-disabled')).toBe('true')
  expect(document.querySelector('[data-testid=chat-row-mark-all-read]')?.getAttribute('aria-disabled')).not.toBe('true')
})

it.each([false, true])('hides an empty owned agent and uses message time on desktop and phone (mobile: %s)', async mobile => {
  const { installOwnedAgentEntry } = await import('../../../apps/desktop/src/lib/ownedAgentConversation')
  const remove = installOwnedAgentEntry({ owns: id => id === 'unused-agent', open: () => true })
  try {
    const empty = chat({ id: 'empty-owned', kind: 'dm', peer_user_id: 'unused-agent', created_at: '2026-10-30T03:48:07Z', last_message_at: null, last_message_preview: null, unread_count: 0, is_pinned: false, is_marked_unread: false })
    const older = chat({ id: 'older-dm', kind: 'dm', peer_user_id: 'old-peer', last_message_at: '2026-10-29T00:00:00Z', unread_count: 99 })
    const newer = chat({ id: 'newer-dm', kind: 'dm', peer_user_id: 'new-peer', last_message_at: '2026-10-30T01:00:00Z', unread_count: 0 })
    await renderWithAppProviders(h, createNode(ChatListPanel, { mobile, activeTab: 'chats' }), { chat: { chats: [empty, older, newer], activeChatId: null } })
    expect([...h.container.querySelectorAll('[data-chat-row]')].map(row => row.getAttribute('data-chat-row'))).toEqual(['newer-dm', 'older-dm'])
  } finally { remove() }
})
