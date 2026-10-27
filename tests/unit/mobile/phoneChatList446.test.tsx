// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { ChatListPanel, TopicSubRow } from '../../../apps/desktop/src/components/ChatListPanel'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../support/testHarness'

const state = vi.hoisted(() => ({ statuses: {} as Record<string, AgentDisplayStatus>, read: vi.fn(async (_input: { chats: { id: string }[] }) => ({ failedChats: 0 })), select: vi.fn(), open: vi.fn(async () => {}) }))
vi.mock('../../../apps/desktop/src/lib/chatUnreadLocator', async original => ({ ...await original<typeof import('../../../apps/desktop/src/lib/chatUnreadLocator')>(), markChatsReadAndRefresh: state.read }))
vi.mock('../../../apps/desktop/src/platform', () => import('../../support/capacitorPlatformTestDouble'))
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', async () => ({
  ...await import('../../support/agentDisplayStatusTestDouble'),
  useAgentDisplayStatuses: () => state.statuses,
}))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: [{ device_id: 'mac', projects: [{ localProjectId: 'local', name: 'Planning', createdAt: '2026-10-01', chatId: 'group', folders: [] }] }] }),
}))

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); state.statuses = {}; vi.clearAllMocks() })
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

it('the phone project folder shows attention only when an agent needs input, with no marker on desktop', async () => {
  state.statuses = { 'task-agent': 'needs_user' }
  await render(true)
  expect(row().querySelector('[data-testid="phone-project-waiting"]')).not.toBeNull()
  state.statuses = { 'task-agent': 'working' }
  await render(true)
  expect(row().querySelector('[data-testid="phone-project-waiting"]')).toBeNull()
  state.statuses = { 'task-agent': 'needs_user' }
  await render(false)
  expect(row().querySelector('[data-testid="phone-project-waiting"]')).toBeNull()
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
    'conversation-row-copy-resource-url', 'conversation-row-send-resource-url', 'conversation-row-mark-read', 'conversation-row-pin', 'conversation-row-notifications', 'chat-row-mark-all-read', 'conversation-row-delete-chat',
  ])
  expect(state.select).not.toHaveBeenCalled()
  expect(state.open).not.toHaveBeenCalled()
  await clickElement(readAction())
  expect(state.read).toHaveBeenCalledOnce()
  expect(state.read.mock.calls[0][0].chats.map(chat => chat.id)).toEqual(['group', 'task-topic'])
})

it('phone topic long-press marks its own scope and leaves the parent unread', async () => {
  const clicked = vi.fn()
  await renderWithAppProviders(h, createNode(TopicSubRow, { topic, mobile: true, isActive: false, tabIndex: 0, onClick: clicked, onFocus: vi.fn(), onKeyDown: vi.fn(), onPin: vi.fn(), onSetNotificationLevel: vi.fn(), onDelete: vi.fn() }), { chat: { chats: [source, topic, orphan] } })
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
