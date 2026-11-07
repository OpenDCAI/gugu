// @vitest-environment jsdom
import { act, createRef } from 'react'
import { runInAction } from 'mobx'
import { installedExtensionsStore } from '../../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { EXTENSION_API_VERSION, parseExtensionManifest } from '../../../../../apps/desktop/src/session/shared/extensions/manifest'
import enMessaging from '../../../../../apps/desktop/src/i18n/locales/en-US/messaging'
import zhMessaging from '../../../../../apps/desktop/src/i18n/locales/zh-CN/messaging'
import { UI_EVENTS } from '../../../../../apps/desktop/src/lib/uiEvents'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, GroupChatSettings, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import type { groupAgentStatusIndicatorProps } from '../../../../../apps/desktop/src/lib/groupAgentStatus'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

/** Topic chatter: unread, none of it addressed to you. */
const topicFixture = (patch: Partial<ChatItem>) => chat({ ...patch, unread_locator: { stream_id: 'main', stream_kind: 'main', thread_root_id: null, message_id: 'first', message_seq: 1,
  unread_count: patch.unread_count ?? 0, addressed_count: 0, cursor_seq: 0, version: 1, is_marked_unread: false } })

let harness: ReturnType<typeof createReactHarness>
const pinChat = vi.fn(async () => {})
const setChatNotificationLevel = vi.fn(async () => {})
const onOpenInfo = vi.fn()
const onCloseInfo = vi.fn()
const onSearch = vi.fn()
const onOpenFolder = vi.fn()
let headerWidth: number
const resizeCallbacks = new Set<ResizeObserverCallback>()

beforeEach(() => {
  harness = createReactHarness()
  headerWidth = 900
  vi.clearAllMocks()
  runInAction(() => {
    installedExtensionsStore.manifests = [parseExtensionManifest({ id: 'toolbar-app', name: 'Toolbar App', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Toolbar App' }] } })]
    installedExtensionsStore.disabled = []
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, left: 0, top: 0, width: this.hasAttribute('data-chat-area-header') ? headerWidth : 32, height: 40, right: headerWidth, bottom: 40, toJSON() {} }
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { resizeCallbacks.add(this.callback) }
    disconnect() { resizeCallbacks.delete(this.callback) }
    unobserve() {}
  })
})
afterEach(() => { runInAction(() => { installedExtensionsStore.manifests = []; installedExtensionsStore.disabled = [] }); harness.cleanup(); resizeCallbacks.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function header(kind: 'group' | 'topic' | 'dm', options: { mobile?: boolean; menu?: boolean; infoShown?: boolean; stripNarrow?: boolean; pinned?: boolean; muted?: boolean; topics?: ChatItem[]; status?: 'working' | 'needs_user' } = {}) {
  if (options.stripNarrow) { harness.container.className = 'session-tab-bar'; harness.container.setAttribute('data-strip-narrow', '') }
  const room = {
    snapshot: { humans: [{ id: 'human' }], agents: [{ id: 'agent-1' }, { id: 'agent-2' }] } as GroupCollabSnapshot,
    settings: { my_role: 'member', can_manage: false, allow_member_invite: false } as GroupChatSettings,
    statusIndicatorProps: { role: 'img' as const, 'data-agent-display-status': options.status ?? 'working', 'aria-label': 'Working' } as ReturnType<typeof groupAgentStatusIndicatorProps>,
    onReload: vi.fn(async () => {}),
  }
  const chat = { id: 'chat', kind, is_pinned: options.pinned ?? false, notification_level: options.muted ? 'none' : 'all' }
  const props = {
    isGroupChat: kind === 'group', isRoomChat: kind !== 'dm', mobile: options.mobile,
    infoShown: options.infoShown ?? false, showHeaderMenu: options.menu ?? false,
    room, moreButtonRef: createRef<HTMLButtonElement>(),
    onSearch, onOpenFolder, onOpenInfo, onCloseInfo,
    onToggleHeaderMenu: vi.fn(), onCloseHeaderMenu: vi.fn(),
  }
  await renderWithAppProviders(harness, createNode('div', { 'data-chat-area-header': '' }, createNode(ChatHeaderActions, props)), {
    auth: null, chat: { activeChatId: chat.id, activeChat: chat as never, chats: [chat, ...(options.topics ?? [])] as never, pinChat, setChatNotificationLevel },
  })
}

const button = (label: string) => [...harness.container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((element) => element.getAttribute('aria-label') === label)
const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.includes(text))

describe('final group toolbar v4', () => {
  it('[immediate] removes duplicate installed Apps only from wide-group More', async () => {
    await header('group', { menu: true })
    expect(document.querySelector('[data-testid="chat-header-apps-button"]')).not.toBeNull()
    expect(document.querySelectorAll('[data-testid="chat-header-menu-app"]')).toHaveLength(0)
  })

  it.each(['width', 'mobile', 'strip', 'dm', 'topic'] as const)('[immediate control] %s keeps the existing installed-App menu', async (mode) => {
    headerWidth = mode === 'width' ? 560 : 900
    await header(mode === 'dm' || mode === 'topic' ? mode : 'group', { menu: true, mobile: mode === 'mobile', stripNarrow: mode === 'strip' })
    const app = document.querySelector<HTMLElement>('[data-testid="chat-header-menu-app"]')
    expect(app?.querySelector('.gg-menu-item-label')?.textContent).toBe('Toolbar App')
    if (mode !== 'dm' && mode !== 'topic') {
      expect(document.querySelector('[data-testid="chat-header-apps-button"]')).toBeNull()
      expect(menuItem('应用')).toBeDefined()
    }
    const opened = vi.fn()
    window.addEventListener(UI_EVENTS.openApp, opened)
    try { await clickElement(app!) } finally { window.removeEventListener(UI_EVENTS.openApp, opened) }
    expect((opened.mock.calls[0]![0] as CustomEvent).detail).toEqual({ extensionId: 'toolbar-app', chatId: 'chat' })
  })

  it.each(['group', 'topic'] as const)('[immediate] %s member pill contains only the count and keeps its accessible name', async (kind) => {
    await header(kind)
    const members = button('成员列表')!
    expect(members.textContent).toBe('3')
    expect(members.querySelector('svg')).not.toBeNull()
    expect(members.title).toBe('成员列表')
  })

  it.each(['working', 'needs_user'] as const)('[immediate] member pill omits the %s status glyph', async (status) => {
    await header('group', { status })
    expect(button('成员列表')?.querySelector('[data-agent-display-status]')).toBeNull()
  })

  it.each([['en-US', enMessaging, 'Apps'], ['zh-CN', zhMessaging, '应用']] as const)('[immediate] %s uses the short Apps label', (_locale, catalog, label) => {
    expect(catalog.header.groupApps).toBe(label)
  })

  it('puts members, topics, invitation, Apps and More on a wide group; search and files live in More', async () => {
    await header('group', { menu: true })
    expect(button('成员列表')?.textContent).toContain('3')
    expect(button('话题')).toBeDefined()
    expect(button('邀请')).toBeDefined()
    expect(button('应用')).toBeDefined()
    expect(button('在对话中搜索')).toBeUndefined()
    expect(button('文件')).toBeUndefined()
    expect(menuItem('搜索聊天记录')).toBeDefined()
    expect(menuItem('文件')).toBeDefined()
    expect(harness.container.querySelector('[data-agent-display-status="working"]')).toBeNull()
  })

  it('mobile: no topics button, invitation and Apps are in More', async () => {
    headerWidth = 900
    await header('group', { menu: true, mobile: true })
    expect(button('话题')).toBeUndefined()
    expect(button('邀请')).toBeUndefined()
    expect(button('应用')).toBeUndefined()
    expect(menuItem('邀请')).toBeDefined()
    expect(menuItem('应用')).toBeDefined()
  })

  it.each(['strip', 'width'] as const)('%s: keeps topics but moves invitation and Apps into More', async (reason) => {
    headerWidth = reason === 'width' ? 560 : 900
    await header('group', { menu: true, stripNarrow: reason === 'strip' })
    expect(button('话题')).toBeDefined()
    expect(button('邀请')).toBeUndefined()
    expect(button('应用')).toBeUndefined()
    expect(menuItem('邀请')).toBeDefined()
    expect(menuItem('应用')).toBeDefined()
  })

  it('uses the own header width, restoring wide actions above the inclusive 560px boundary', async () => {
    headerWidth = 560
    await header('group')
    expect(button('应用')).toBeUndefined()
    await act(async () => { headerWidth = 561; for (const callback of resizeCallbacks) callback([], {} as ResizeObserver) })
    expect(button('应用')).toBeDefined()
  })

  it.each(['wide', 'strip', 'width'] as const)('%s: keeps the topic unread total and dropdown row counts consistent', async (mode) => {
    headerWidth = mode === 'width' ? 560 : 900
    const topics = [
      topicFixture({ id: 'live', kind: 'topic', source_chat_id: 'chat', unread_count: 4 }),
      topicFixture({ id: 'muted', kind: 'topic', source_chat_id: 'chat', unread_count: 120, is_muted: true }),
      topicFixture({ id: 'archived', kind: 'topic', source_chat_id: 'chat', unread_count: 70, status: 'archived' }),
      topicFixture({ id: 'elsewhere', kind: 'topic', source_chat_id: 'another-group', unread_count: 90 }),
    ]
    await header('group', { topics, stripNarrow: mode === 'strip' })
    const trigger = button('话题')!
    expect(trigger.querySelector('.gg-chip')?.textContent).toBe('4')
    await clickElement(trigger)
    await vi.waitFor(() => expect(document.querySelector('[data-topic-id="live"] .gg-chip')?.textContent).toBe('4'))
    expect(document.querySelector('[data-topic-id="muted"] .gg-chip')?.textContent).toBe('99+')
    expect(document.querySelector('[data-topic-id="archived"]')).toBeNull()
    expect(document.querySelector('[data-topic-id="elsewhere"]')).toBeNull()
  })

  it.each([{ count: 0, shown: undefined }, { count: 120, shown: '99+' }])('compact topic count $count follows the existing zero and overflow display', async ({ count, shown }) => {
    await header('group', { stripNarrow: true, topics: [topicFixture({ kind: 'topic', source_chat_id: 'chat', unread_count: count })] })
    expect(button('话题')?.querySelector('.gg-chip')?.textContent).toBe(shown)
  })

  it('keeps independent topics free of group-only tools, with members and conversation information', async () => {
    await header('topic', { menu: true })
    expect(button('成员列表')).toBeDefined()
    expect(button('话题')).toBeUndefined()
    expect(button('邀请')).toBeUndefined()
    expect(button('应用')).toBeUndefined()
    expect(menuItem('会话信息')).toBeDefined()
  })

  it('opens the members page and toggles it closed without changing the block title', async () => {
    await header('group')
    await clickElement(button('成员列表')!)
    expect(onOpenInfo).toHaveBeenCalledWith('members')
    await header('group', { infoShown: true })
    await clickElement(button('成员列表')!)
    expect(onCloseInfo).toHaveBeenCalledOnce()
  })

  it.each(['group', 'topic', 'dm'] as const)('%s: pin and mute use chat writes and leave More open', async (kind) => {
    await header(kind, { menu: true })
    const switches = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
    expect(switches).toHaveLength(2)
    expect(switches.every((element) => element.getAttribute('aria-checked') === 'false')).toBe(true)
    await clickElement(switches[0]!)
    expect(pinChat).toHaveBeenCalledWith('chat', true)
    expect(document.querySelector('[data-testid="group-header-menu"]')).not.toBeNull()
    await clickElement(switches[1]!)
    expect(setChatNotificationLevel).toHaveBeenCalledWith('chat', 'none')
    expect(document.querySelector('[data-testid="group-header-menu"]')).not.toBeNull()
    if (kind === 'dm') {
      expect(button('文件'), 'a private chat has no header folder button, like a group').toBeUndefined()
      await clickElement(menuItem('文件')!)
      expect(onOpenFolder).toHaveBeenCalledOnce()
    }
  })

  it('moves search into More while retaining its canonical search callback and shortcut hint', async () => {
    await header('group', { menu: true })
    const search = document.querySelector<HTMLElement>('[data-testid="chat-header-search-button"]')!
    expect(search.getAttribute('role')).toBe('menuitem')
    expect(search.textContent).toContain('⌘F')
    await clickElement(search)
    expect(onSearch).toHaveBeenCalledOnce()
  })

  it.each(['Enter', ' '])('keyboard %j exposes checked state and toggles existing pin/mute state off', async (key) => {
    await header('group', { menu: true, pinned: true, muted: true })
    const switches = [...document.querySelectorAll<HTMLElement>('[role="menuitemcheckbox"]')]
    expect(switches).toHaveLength(2)
    expect(switches.every((element) => element.getAttribute('aria-checked') === 'true')).toBe(true)
    const activate = async (element: HTMLElement) => act(async () => {
      element.focus()
      element.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      element.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }))
    })
    await activate(switches[0]!)
    expect(pinChat).toHaveBeenCalledExactlyOnceWith('chat', false)
    await activate(switches[1]!)
    expect(setChatNotificationLevel).toHaveBeenCalledExactlyOnceWith('chat', 'all')
    expect(document.querySelector('[data-testid="group-header-menu"]')).not.toBeNull()
  })
})
