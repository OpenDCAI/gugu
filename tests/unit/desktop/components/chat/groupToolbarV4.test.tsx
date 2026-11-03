// @vitest-environment jsdom
import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupChatSettings, GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

let harness: ReturnType<typeof createReactHarness>
const pinChat = vi.fn(async () => {})
const setChatNotificationLevel = vi.fn(async () => {})
const onOpenInfo = vi.fn()
const onCloseInfo = vi.fn()
const onEnterSearchMode = vi.fn()
const onOpenFolder = vi.fn()
let headerWidth: number
const resizeCallbacks = new Set<ResizeObserverCallback>()

beforeEach(() => {
  harness = createReactHarness()
  headerWidth = 900
  vi.clearAllMocks()
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
afterEach(() => { harness.cleanup(); resizeCallbacks.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function header(kind: 'group' | 'topic' | 'dm', options: { mobile?: boolean; menu?: boolean; infoShown?: boolean; stripNarrow?: boolean } = {}) {
  if (options.stripNarrow) { harness.container.className = 'session-tab-bar'; harness.container.setAttribute('data-strip-narrow', '') }
  const room = {
    snapshot: { humans: [{ id: 'human' }], agents: [{ id: 'agent-1' }, { id: 'agent-2' }] } as GroupCollabSnapshot,
    settings: { my_role: 'member', can_manage: false, allow_member_invite: false } as GroupChatSettings,
    statusIndicatorProps: { role: 'img' as const, 'data-agent-display-status': 'working', 'aria-label': 'Working' },
    onReload: vi.fn(async () => {}),
  }
  const chat = { id: 'chat', kind, is_pinned: false, notification_level: 'all' }
  const props = {
    isGroupChat: kind === 'group', isRoomChat: kind !== 'dm', mobile: options.mobile,
    searchMode: false, folderShown: false, infoShown: options.infoShown ?? false, showHeaderMenu: options.menu ?? false,
    room, moreButtonRef: createRef<HTMLButtonElement>(),
    onEnterSearchMode, onOpenFolder, onCloseWorkspacePanel: vi.fn(), onOpenInfo, onCloseInfo,
    onToggleHeaderMenu: vi.fn(), onCloseHeaderMenu: vi.fn(),
  }
  await renderWithAppProviders(harness, createNode('div', { 'data-chat-area-header': '' }, createNode(ChatHeaderActions, props)), {
    auth: null, chat: { activeChatId: chat.id, activeChat: chat as never, chats: [chat] as never, pinChat, setChatNotificationLevel },
  })
}

const button = (label: string) => [...harness.container.querySelectorAll<HTMLButtonElement>('button[aria-label]')].find((element) => element.getAttribute('aria-label') === label)
const menuItem = (text: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) => element.textContent?.includes(text))

describe('final group toolbar v4', () => {
  it('puts members, topics, invitation, Apps and More on a wide group; search and files live in More', async () => {
    await header('group', { menu: true })
    expect(button('成员列表')?.textContent).toContain('3')
    expect(button('话题')).toBeDefined()
    expect(button('邀请')).toBeDefined()
    expect(button('群应用')).toBeDefined()
    expect(button('在对话中搜索')).toBeUndefined()
    expect(button('群文件夹')).toBeUndefined()
    expect(menuItem('搜索聊天记录')).toBeDefined()
    expect(menuItem('群文件夹')).toBeDefined()
    expect(harness.container.querySelector('[data-agent-display-status="working"]')).not.toBeNull()
  })

  it.each(['mobile', 'strip', 'width'] as const)('%s: keeps topics but moves invitation and Apps into More', async (reason) => {
    headerWidth = reason === 'width' ? 560 : 900
    await header('group', { menu: true, mobile: reason === 'mobile', stripNarrow: reason === 'strip' })
    expect(button('话题')).toBeDefined()
    expect(button('邀请')).toBeUndefined()
    expect(button('群应用')).toBeUndefined()
    expect(menuItem('邀请')).toBeDefined()
    expect(menuItem('群应用')).toBeDefined()
  })

  it('uses the own header width, restoring wide actions above the inclusive 560px boundary', async () => {
    headerWidth = 560
    await header('group')
    expect(button('群应用')).toBeUndefined()
    await act(async () => { headerWidth = 561; for (const callback of resizeCallbacks) callback([], {} as ResizeObserver) })
    expect(button('群应用')).toBeDefined()
  })

  it('keeps independent topics free of group-only tools, with members and conversation information', async () => {
    await header('topic', { menu: true })
    expect(button('成员列表')).toBeDefined()
    expect(button('话题')).toBeUndefined()
    expect(button('邀请')).toBeUndefined()
    expect(button('群应用')).toBeUndefined()
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
    const switches = [...document.querySelectorAll<HTMLElement>('[role="switch"]')]
    expect(switches).toHaveLength(2)
    await clickElement(switches[0]!)
    expect(pinChat).toHaveBeenCalledWith('chat', true)
    expect(document.querySelector('[data-testid="group-header-menu"]')).not.toBeNull()
    await clickElement(switches[1]!)
    expect(setChatNotificationLevel).toHaveBeenCalledWith('chat', 'none')
    expect(document.querySelector('[data-testid="group-header-menu"]')).not.toBeNull()
    if (kind === 'dm') {
      await clickElement(button('文件夹')!)
      expect(onOpenFolder).toHaveBeenCalledOnce()
    }
  })

  it('moves search into More while retaining its canonical search callback and shortcut hint', async () => {
    await header('group', { menu: true })
    const search = document.querySelector<HTMLElement>('[data-testid="chat-header-search-button"]')!
    expect(search.getAttribute('role')).toBe('menuitem')
    expect(search.textContent).toContain('⌘F')
    await clickElement(search)
    expect(onEnterSearchMode).toHaveBeenCalledOnce()
  })
})
