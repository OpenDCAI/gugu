// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'
import { ChatListPanel } from '../../../apps/desktop/src/components/ChatListPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders, typeInto } from '../../support/testHarness'

const state = vi.hoisted(() => ({ statuses: {} as Record<string, AgentDisplayStatus> }))
vi.mock('../../../apps/desktop/src/platform', () => import('../../support/capacitorPlatformTestDouble'))
vi.mock('../../../apps/desktop/src/hooks/useAgentDisplayStatus', async () => ({
  ...await import('../../support/agentDisplayStatusTestDouble'),
  useAgentDisplayStatuses: () => state.statuses,
}))
vi.mock('../../../apps/desktop/src/store/devicesContext', () => ({
  useDevicesStore: () => ({ devices: [{ device_id: 'mac', projects: [{ localProjectId: 'local', name: 'Planning', createdAt: '2026-10-01', chatId: 'group', folders: [] }] }] }),
}))

let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); state.statuses = {} })
afterEach(() => h.cleanup())
const source = chat({ id: 'group', kind: 'group', name: 'Planning', unread_count: 2, member_user_ids: ['task-agent'] })
const topic = chat({ id: 'task-topic', kind: 'topic', name: 'Fix login', source_chat_id: source.id, unread_count: 8 })
const orphan = chat({ id: 'orphan-topic', kind: 'topic', name: 'Older task', source_chat_id: 'archived', unread_count: 4 })
const render = (mobile: boolean, chats = [source, topic, orphan]) => renderWithAppProviders(h, createNode(ChatListPanel, { mobile, activeTab: 'chats', placement: mobile ? 'page' : 'sidebar' }), { chat: { chats }, contacts: {} })
const row = () => h.container.querySelector('[data-chat-row="group"]')!

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
