// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'

const topicsCss = readFileSync('apps/desktop/src/components/chat/pinned-topics.css', 'utf8')

const io = vi.hoisted(() => ({ rows: new Map<string, Record<string, unknown>>(), failRead: false, failWrite: false, listeners: [] as (() => void)[] }))
vi.mock('@/lib/supabase', async (original) => {
  const { versionedSettingsClient } = await import('../../../../support/versionedSettingsTestDouble')
  return { ...await original<typeof import('@/lib/supabase')>(), identityDb: versionedSettingsClient(io) }
})
vi.mock('@/lib/realtimeChannel', () => ({ subscribePrivateUserEventBus: (_user: string, _event: string, receive: (payload: unknown) => void) => {
  io.listeners.push(() => receive({ setting: { user_id: 'u', scope: 'chat:g' } }))
  return {}
}, unsubscribePrivateUserEventBus: vi.fn() }))
const marked = vi.hoisted(() => ({ scopes: [] as string[][] }))
vi.mock('@/lib/chatUnreadLocator', async (original) => ({ ...await original<typeof import('@/lib/chatUnreadLocator')>(),
  markChatsReadAndRefresh: async ({ chats }: { chats: readonly { id: string }[] }) => { marked.scopes.push(chats.map((chat) => chat.id)); return { failedChats: 0 } } }))
vi.mock('@/platform', async (original) => { const actual = await original<typeof import('@/platform')>(); return { ...actual, platform: { ...actual.platform, subscribeAppForeground: () => () => {} } } })

const { ChatHeaderActions } = await import('@/components/chat/ChatHeaderActions')
const { PinnedTopicTabs } = await import('@/components/chat/PinnedTopicTabs')
const { queryClient } = await import('@/session/renderer/lib/query-client')
const { unsubscribePrivateUserEventBus } = await import('@/lib/realtimeChannel')
const { drainTopicSplitRequest } = await import('@/lib/topicSplitRequest')
let harness: ReturnType<typeof createReactHarness>
const topics = [
  chat({ id: 'new', kind: 'topic', source_chat_id: 'g', name: 'Recent topic', last_message_at: '2026-10-29T00:00:00Z', last_message_preview: 'Alex: Latest update', unread_count: 4 }),
  chat({ id: 'old', kind: 'topic', source_chat_id: 'g', name: 'Older topic', last_message_at: '2026-10-20T00:00:00Z', last_message_preview: 'Muted preview', unread_count: 120, is_muted: true }),
]
const summaries = topics.map((topic) => ({ chat_id: topic.id, name: topic.name, source_message_id: topic.id, creator_user_id: 'u', last_message_at: topic.last_message_at, message_count: 2, participant_count: 2, is_participant: true }))
function save(ids: string[], userId = 'u') { io.rows.set(`${userId}/chat:g`, { scope: 'chat:g', config: { pinnedTopicIds: ids }, updated_at: '2026-10-29T00:00:00.000Z' }) }
const options = (userId = 'u') => ({ auth: { id: userId }, chat: { activeChatId: 'g', chats: topics } })
const topicMenu = () => createNode(ChatHeaderActions, {
  isGroupChat: true, isRoomChat: true, searchMode: false, folderShown: false, infoShown: false, showHeaderMenu: false,
  moreButtonRef: createRef<HTMLButtonElement>(), onEnterSearchMode: vi.fn(), onOpenFolder: vi.fn(), onCloseWorkspacePanel: vi.fn(),
  onOpenInfo: vi.fn(), onCloseInfo: vi.fn(), onToggleHeaderMenu: vi.fn(), onCloseHeaderMenu: vi.fn(),
})
const savedPins = () => (io.rows.get('u/chat:g')?.config as { pinnedTopicIds?: string[] } | undefined)?.pinnedTopicIds
const tabs = () => [...document.querySelectorAll('[role="tab"]')]
const strip = (mobile: boolean, onPick = vi.fn(), current: string | null = null) => createNode(PinnedTopicTabs, { chatId: 'g', topics: summaries, messages: [], current, mobile, onPick })
beforeEach(() => {
  vi.mocked(unsubscribePrivateUserEventBus).mockClear()
  io.rows.clear(); io.listeners.length = 0; io.failRead = false; marked.scopes.length = 0
  queryClient.clear(); drainTopicSplitRequest('g')
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); queryClient.clear() })

describe('rich Topics menu', () => {
  it('leaves no permanent pin-width padding on a topic with no unread messages', async () => {
    save(['old'])
    await renderWithAppProviders(harness, topicMenu(), { ...options(), chat: { activeChatId: 'g', chats: topics.map(topic => ({ ...topic, unread_count: 0 })) } })
    await clickElement(document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="group-menu-topic"]')).toHaveLength(2))
    const row = document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-menu-topic"]')!
    expect(row.querySelector('.gg-chip')).toBeNull()
    expect(row.style.paddingInlineEnd, 'no reserved pin column in the resting row').toBe('')
  })

  it('replaces the unread chip with the existing pin action when the row takes keyboard focus', async () => {
    const style = document.createElement('style'); style.textContent = topicsCss; document.head.append(style)
    try {
      save(['old'])
      await renderWithAppProviders(harness, topicMenu(), options())
      await clickElement(document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!)
      await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="group-menu-topic"]')).toHaveLength(2))
      const open = document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-menu-topic"]')!
      const chip = open.closest<HTMLElement>('[data-topic-id]')!.querySelector<HTMLElement>('.gg-chip')!
      const displayed = () => {
        for (let node: HTMLElement | null = chip; node; node = node.parentElement) {
          if (getComputedStyle(node).display === 'none') return false
        }
        return true
      }
      const pin = document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-topic-pin"]')!
      expect(chip.textContent).toBe('4')
      expect(displayed()).toBe(true)
      await act(async () => open.focus())
      expect(document.activeElement).toBe(open)
      expect(displayed(), 'the count and action share the trailing space').toBe(false)
      expect(getComputedStyle(pin).display).not.toBe('none')
      expect(document.querySelector('[data-topic-id="old"] .gg-topic-name svg')).not.toBeNull()
      await clickElement(pin)
      await vi.waitFor(() => expect(savedPins()).toEqual(['old', 'new']))
      expect(drainTopicSplitRequest('g')).toBeNull()
    } finally { style.remove() }
  })

  it('renders distinct pin and unpin icons inside their action buttons', async () => {
    save(['old'])
    await renderWithAppProviders(harness, topicMenu(), options())
    await clickElement(document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="group-topic-pin"]')).toHaveLength(2))
    for (const id of ['old', 'new']) {
      const icon = document.querySelector(`[data-topic-id="${id}"] [data-testid="group-topic-pin"] svg`)
      expect(icon).not.toBeNull()
      expect(icon?.getAttribute('width')).toBe('14')
      expect(icon?.getAttribute('height')).toBe('14')
    }
    const iconBody = (id: string) => document.querySelector(`[data-topic-id="${id}"] [data-testid="group-topic-pin"] svg`)?.innerHTML
    expect(iconBody('old')).not.toBe(iconBody('new'))
  })

  it('shows activity, preview and muted unread counts, and pins without closing or opening a topic', async () => {
    save(['old'])
    await renderWithAppProviders(harness, topicMenu(), options())
    const submenu = document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!
    expect(submenu.querySelector('.gg-chip')?.textContent).toBe('4')
    await clickElement(submenu)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="group-menu-topic"]')).toHaveLength(2))
    await vi.waitFor(() => expect([...document.querySelectorAll('[data-testid="group-menu-topic"]')].map((row) => row.querySelector('.gg-topic-name')?.textContent)).toEqual(['Older topic', 'Recent topic']))
    const rows = [...document.querySelectorAll('[data-testid="group-menu-topic"]')]
    expect(rows.map((row) => row.querySelector('.gg-topic-name')?.textContent)).toEqual(['Older topic', 'Recent topic'])
    expect(rows[0]?.closest('[data-topic-id]')?.querySelector('.gg-chip')?.textContent).toBe('99+')
    expect(rows[0]?.closest('[data-topic-id]')?.querySelector('.gg-chip')?.getAttribute('data-tone')).toBeNull()
    expect(rows[1]?.querySelector('.gg-topic-preview')?.textContent).toContain('Alex: Latest update')
    expect(rows[1]?.querySelector('.gg-topic-time')?.textContent).toBeTruthy()
    const popup = document.querySelector<HTMLElement>('[data-testid="group-topics-popup"]')!
    expect(popup.classList.contains('gg-topics-menu')).toBe(false)
    expect(popup.style.width).toBe('320px')
    expect(popup.style.maxHeight).toBe('min(360px, var(--available-height))')
    // Observe the pin action after the submenu's own opening/focus events have settled.
    await clickElement(document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-topic-pin"]')!)
    await vi.waitFor(() => expect(savedPins()).toEqual(['old', 'new']))
    expect(document.querySelector('[data-testid="group-topics-popup"]')).not.toBeNull()
    expect(drainTopicSplitRequest('g')).toBeNull()
    await clickElement(document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-menu-topic"]')!)
    expect(drainTopicSplitRequest('g')).toMatchObject({ chatId: 'new', sourceChatId: 'g', focusComposer: true })
  })

  it('exposes a real retry and disables pinning when preferences could not be loaded', async () => {
    io.failRead = true
    await renderWithAppProviders(harness, topicMenu(), options())
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

describe('Topics menu row actions', () => {
  const openRowMenu = async (topicId: string) => {
    await renderWithAppProviders(harness, topicMenu(), { ...options(), chat: { activeChatId: 'g', chats: [chat({ id: 'g', kind: 'group', unread_count: 2 }), ...topics, chat({ id: 'elsewhere', kind: 'topic', source_chat_id: 'other', unread_count: 5 })] } })
    await clickElement(document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!)
    await vi.waitFor(() => expect(document.querySelectorAll('[data-testid="group-menu-topic"]')).toHaveLength(2))
    await act(async () => {
      document.querySelector(`[data-topic-id="${topicId}"] [data-testid="group-menu-topic"]`)!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 60 }))
    })
    await vi.waitFor(() => expect(document.querySelector('[data-testid="conversation-row-mark-read"]')).not.toBeNull())
  }

  it('marks the right-clicked topic read through the shared row menu', async () => {
    save([])
    await openRowMenu('new')
    expect([...document.querySelectorAll('[data-testid^="conversation-row-"], [data-testid="chat-row-mark-all-read"]')].map((item) => item.getAttribute('data-testid')))
      .toEqual(['conversation-row-mark-read', 'chat-row-mark-all-read'])
    await clickElement(document.querySelector<HTMLElement>('[data-testid="conversation-row-mark-read"]')!)
    await vi.waitFor(() => expect(marked.scopes).toEqual([['new']]))
  })

  it('marks every topic of this group read, not the group line or other groups', async () => {
    save([])
    await openRowMenu('new')
    await clickElement(document.querySelector<HTMLElement>('[data-testid="chat-row-mark-all-read"]')!)
    await vi.waitFor(() => expect(marked.scopes.map((ids) => [...ids].sort())).toEqual([['new', 'old']]))
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
    await vi.waitFor(() => expect(queryClient.getQueryData(['chat-pins', 'u', 'g'])).toEqual({ topicIds: [] }))
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
  await renderWithAppProviders(harness, createNode('div', {}, strip(true), topicMenu()), options())
  await clickElement(document.querySelector<HTMLElement>('[data-testid="group-menu-topics"]')!)
  const item = () => document.querySelector<HTMLElement>('[data-topic-id="new"] [data-testid="group-topic-pin"]')!
  await vi.waitFor(() => expect(item()?.hasAttribute('data-disabled')).toBe(false))
  await clickElement(item())
  await vi.waitFor(() => expect(document.querySelector('[data-testid="phone-chat-tab-new"]')).not.toBeNull())
  expect(savedPins()).toEqual(['new'])
  expect(io.listeners).toHaveLength(1)
  await renderWithAppProviders(harness, createNode('div'), options())
  expect(unsubscribePrivateUserEventBus).toHaveBeenCalledTimes(1)
})
