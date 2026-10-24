// @vitest-environment jsdom
//
// 主人 10-05「我发现私聊也是得有面板的呀」:私聊和群、话题一样有自己的工作区和右栏。页头的「工作区」按钮私聊也有 ——
// 桌面和手机都在页头(手机私聊图标少,不收进 ⋯);手机群聊照旧收进 ⋯。对照(父提交):私聊页头没有这颗按钮,⋯ 里也没有。
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

vi.mock('@/lib/chatAppPins', () => ({ readChatAppPins: async () => [], setChatAppPin: async () => [], watchChatAppPins: () => () => {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const header = (props: { isGroupChat: boolean; isRoomChat: boolean; mobile: boolean }, onOpenFolder = vi.fn()) =>
  renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    ...props,
    searchMode: false,
    folderShown: false,
    memberListOpen: false,
    showHeaderMenu: false,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onEnterSearchMode: vi.fn(),
    onOpenFolder,
    onCloseWorkspacePanel: vi.fn(),
    onOpenSettingsDrawer: vi.fn(),
    onOpenMemberList: vi.fn(),
    onCloseRightSurfaces: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
    onOpenAnnouncement: vi.fn(),
  }), { chat: { activeChatId: 'c', chats: [{ id: 'c', kind: props.isGroupChat ? 'group' : 'dm' }] as never } }) // the button's name: useChatFolderName
const workspaceButton = () => document.querySelector<HTMLElement>('button[aria-label="文件夹"], button[aria-label="群文件夹"]')

describe('a private chat has the folder (workspace) button in its header', () => {
  it.each([false, true])('mobile=%s: it is there, and opens the folder in the panel', async (mobile) => {
    const onOpen = vi.fn()
    await header({ isGroupChat: false, isRoomChat: false, mobile }, onOpen)
    expect(workspaceButton()).not.toBeNull()
    expect(workspaceButton()!.getAttribute('aria-label'), 'owner 10-11: a private chat\'s is 文件夹').toBe('文件夹')
    await clickElement(workspaceButton()!)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it('a group on the phone keeps it in ⋯, not in the header (five icons squeeze the name)', async () => {
    await header({ isGroupChat: true, isRoomChat: true, mobile: true })
    expect(workspaceButton()).toBeNull()
  })
})
