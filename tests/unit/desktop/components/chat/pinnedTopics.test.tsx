// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failRead: false, failWrite: false, listeners: [] as (() => void)[] }))
vi.mock('@/lib/supabase', async (original) => {
  const { versionedSettingsClient } = await import('../../../../support/versionedSettingsTestDouble')
  return { ...await original<typeof import('@/lib/supabase')>(), identityDb: versionedSettingsClient(io) }
})
vi.mock('@/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: (_user: string, _event: string, receive: (payload: unknown) => void) => {
  io.listeners.push(() => receive({ setting: { user_id: 'u', scope: 'chat:g' } }))
  return {}
}, unsubscribePrivateUserEventBus: vi.fn() }))
vi.mock('@/platform', async (original) => { const actual = await original<typeof import('@/platform')>(); return { ...actual, platform: { ...actual.platform, subscribeAppForeground: () => () => {} } } })

const { GroupTopicsMenuItem } = await import('@/components/chat/GroupTopicsMenuItem')
const { PinnedTopicTabs } = await import('@/components/chat/PinnedTopicTabs')
const { Menu } = await import('@/components/ui/Menu')
const { queryClient } = await import('@/session/renderer/lib/query-client')
const { drainTopicSplitRequest } = await import('@/lib/topicSplitRequest')
let harness: ReturnType<typeof createReactHarness>
const topics = [
  chat({ id: 'new', kind: 'topic', source_chat_id: 'g', name: 'Recent topic', last_message_at: '2026-10-29T00:00:00Z', last_message_preview: 'Alex: Latest update', unread_count: 4 }),
  chat({ id: 'old', kind: 'topic', source_chat_id: 'g', name: 'Older topic', last_message_at: '2026-10-20T00:00:00Z', last_message_preview: 'Muted preview', unread_count: 120, is_muted: true }),
]
const summaries = topics.map((topic) => ({ chat_id: topic.id, name: topic.name, source_message_id: topic.id, creator_user_id: 'u', last_message_at: topic.last_message_at, message_count: 2, participant_count: 2, is_participant: true }))
function save(ids: string[], userId = 'u') { io.rows.set(`${userId}/chat:g`, { scope: 'chat:g', config: { pinnedTopicIds: ids }, updated_at: '2026-10-29T00:00:00.000Z' }) }
const options = (userId = 'u') => ({ auth: { id: userId }, chat: { activeChatId: 'g', chats: topics } })
const savedPins = () => (io.rows.get('u/chat:g')?.config as { pinnedTopicIds?: string[] } | undefined)?.pinnedTopicIds
const tabs = () => [...document.querySelectorAll('[role="tab"]')]
const strip = (mobile: boolean, onPick = vi.fn(), current: string | null = null) => createNode(PinnedTopicTabs, { chatId: 'g', topics: summaries, messages: [], current, mobile, onPick })
beforeEach(() => {
  io.rows.clear(); io.listeners.length = 0; io.failRead = false
  queryClient.clear(); drainTopicSplitRequest('g')
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); queryClient.clear() })

describe('rich Topics menu', () => {
  it('shows activity, preview and muted unread counts, and pins without closing or opening a topic', async () => {
    save(['old'])
    const close = vi.fn()
    await renderWithAppProviders(harness, createNode(Menu, { x: 0, y: 0, onClose: close }, createNode(GroupTopicsMenuItem, { chatId: 'g' })), options())
    const submenu = document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!
    expect(submenu.querySelector('.gg-chip')?.textContent).toBe('4')
    await clickElement(submenu)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="group-menu-topic"]')).toHaveLength(2))
    await vi.waitFor(() => expect([...document.querySelectorAll('[data-testid="group-menu-topic"]')].map((row) => row.querySelector('.gg-topic-name')?.textContent)).toEqual(['Older topic', 'Recent topic']))
    const rows = [...document.querySelectorAll('[data-testid="group-menu-topic"]')]
    expect(rows.map((row) => row.querySelector('.gg-topic-name')?.textContent)).toEqual(['Older topic', 'Recent topic'])
    expect(rows[0]?.querySelector('.gg-chip')?.textContent).toBe('99+')
    expect(rows[0]?.querySelector('.gg-chip')?.getAttribute('data-tone')).toBeNull()
    expect(rows[1]?.querySelector('.gg-topic-preview')?.textContent).toContain('Alex: Latest update')
    expect(rows[1]?.querySelector('.gg-topic-time')?.textContent).toBeTruthy()
    const popup = document.querySelector<HTMLElement>('.gg-topics-menu')!
    expect(popup.style.width).toBe('320px')
    expect(popup.style.maxHeight).toBe('min(360px, var(--available-height))')
    // Observe the pin action after the submenu's own opening/focus events have settled.
    close.mockClear()
    await clickElement(document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-topic-pin"]')!)
    await vi.waitFor(() => expect(savedPins()).toEqual(['old', 'new']))
    expect(close).not.toHaveBeenCalled()
    expect(drainTopicSplitRequest('g')).toBeNull()
    await clickElement(document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-menu-topic"]')!)
    expect(drainTopicSplitRequest('g')).toMatchObject({ chatId: 'new', sourceChatId: 'g', focusComposer: true })
  })

  it('exposes a real retry and disables pinning when preferences could not be loaded', async () => {
    io.failRead = true
    await renderWithAppProviders(harness, createNode(Menu, { x: 0, y: 0 }, createNode(GroupTopicsMenuItem, { chatId: 'g' })), options())
    await clickElement(document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!)
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="group-topic-pin"]')?.hasAttribute('data-disabled')).toBe(true)
    await clickElement(document.querySelector<HTMLElement>('[data-testid="group-topic-pin"]')!)
    expect(savedPins()).toBeUndefined()
    io.failRead = false
    await clickElement(document.querySelector<HTMLElement>('[role="alert"] button')!)
    await vi.waitFor(() => expect(document.querySelector('[role="alert"]')).toBeNull())
  })
})

describe.each([false, true])('pinned topic tabs (mobile=%s)', (mobile) => {
  it('contains only Group chat and the pinned topics in pin order', async () => {
    save(['old'])
    const onPick = vi.fn()
    await renderWithAppProviders(harness, strip(mobile, onPick), options())
    await vi.waitFor(() => expect(tabs()).toHaveLength(2))
    expect(tabs().map((tab) => tab.getAttribute('data-testid'))).toEqual(['phone-chat-tab-main', 'phone-chat-tab-old'])
    expect(document.querySelector('[data-testid="phone-chat-tab-new"]')).toBeNull()
    await clickElement(document.querySelector<HTMLElement>('[data-testid="phone-chat-tab-old"]')!)
    expect(onPick).toHaveBeenCalledWith(summaries[1])
    await clickElement(document.querySelector<HTMLElement>('[data-testid="phone-chat-tab-main"]')!)
    expect(onPick).toHaveBeenLastCalledWith(null)
  })

  it('keeps Group chat keyboard-reachable when the open topic is not pinned', async () => {
    save(['old'])
    await renderWithAppProviders(harness, strip(mobile, vi.fn(), 'new'), options())
    await vi.waitFor(() => expect(tabs()).toHaveLength(2))
    const group = document.querySelector<HTMLElement>('[data-testid="phone-chat-tab-main"]')!
    expect(group.getAttribute('aria-selected')).toBe('false')
    expect(group.tabIndex).toBe(0)
  })

  it('hides the entire strip when no topic is pinned, even when the group has topics', async () => {
    save([])
    await renderWithAppProviders(harness, strip(mobile), options())
    await vi.waitFor(() => expect(queryClient.getQueryData(['chat-pins', 'u', 'g'])).toEqual({ appIds: [], topicIds: [] }))
    expect(document.querySelector('[data-testid="phone-chat-tabs"]')).toBeNull()
  })

  it('uses refreshed account pins and hides the strip after the final unpin', async () => {
    save(['old'])
    await renderWithAppProviders(harness, strip(mobile), options())
    await vi.waitFor(() => expect(document.querySelector('[data-testid="phone-chat-tab-old"]')).not.toBeNull())
    save(['new'])
    await act(async () => { io.listeners.forEach((receive) => receive()) })
    await vi.waitFor(() => expect(document.querySelector('[data-testid="phone-chat-tab-new"]')).not.toBeNull())
    expect(document.querySelector('[data-testid="phone-chat-tab-old"]')).toBeNull()
    save([])
    await act(async () => { io.listeners.forEach((receive) => receive()) })
    await vi.waitFor(() => expect(document.querySelector('[data-testid="phone-chat-tabs"]')).toBeNull())
  })
})

it('pins from Topics and immediately shows that topic in the shared phone strip', async () => {
  save([])
  await renderWithAppProviders(harness, createNode('div', {}, strip(true), createNode(Menu, { x: 0, y: 0 }, createNode(GroupTopicsMenuItem, { chatId: 'g' }))), options())
  await clickElement(document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!)
  const item = () => document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-topic-pin"]')!
  await vi.waitFor(() => expect(item()?.hasAttribute('data-disabled')).toBe(false))
  await clickElement(item())
  await vi.waitFor(() => expect(document.querySelector('[data-testid="phone-chat-tab-new"]')).not.toBeNull())
  expect(savedPins()).toEqual(['new'])
})
