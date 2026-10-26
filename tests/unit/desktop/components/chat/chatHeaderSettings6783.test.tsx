// @vitest-environment jsdom
//
// #6783 页头只开这个聊天自己的信息(群信息 / 会话信息);私聊(含 agent 私聊)不走 Agent 设置。
// owner 10-26:成员、公告、设置合成一枚「群信息」页签 —— 群聊从成员钮进(落在成员那一页),⋯ 里不再有公告 / 设置;
// 私聊的 ⋯ 里是「会话信息」。
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

vi.mock('@/lib/chatAppPins', () => ({ readChatAppPins: async () => [], setChatAppPin: async () => [], watchChatAppPins: () => () => {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function renderHeader(props: { isGroupChat: boolean; mobile: boolean }) {
  const onOpenInfo = vi.fn()
  await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    ...props,
    isRoomChat: props.isGroupChat,
    searchMode: false,
    folderShown: false,
    infoShown: false,
    showHeaderMenu: true,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onEnterSearchMode: vi.fn(),
    onOpenFolder: vi.fn(),
    onCloseWorkspacePanel: vi.fn(),
    onOpenInfo,
    onCloseInfo: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
  }), { chat: { activeChatId: 'g', chats: [{ id: props.isGroupChat ? 'g' : 'd', kind: props.isGroupChat ? 'group' : 'dm' }] as never } })
  return onOpenInfo
}

const menuInfo = () => document.querySelector('[data-testid="group-menu-settings"]') as HTMLElement | null

describe('#6783 页头 = 这个聊天自己的信息', () => {
  for (const mobile of [true, false]) {
    it(`私聊(${mobile ? '手机' : '桌面'}):⋯ → 会话信息`, async () => {
      const onOpenInfo = await renderHeader({ isGroupChat: false, mobile })
      expect(menuInfo()?.textContent).toContain('会话信息')
      await clickElement(menuInfo()!)
      expect(onOpenInfo).toHaveBeenCalledWith()
    })
    it(`群聊(${mobile ? '手机' : '桌面'}):成员钮 → 群信息落在成员那一页,⋯ 里没有公告 / 设置`, async () => {
      const onOpenInfo = await renderHeader({ isGroupChat: true, mobile })
      expect(menuInfo()).toBeNull()
      expect(document.querySelector('[data-testid="group-menu-announcement"]')).toBeNull()
      // 桌面群聊没有放不下的钉住 App 时 ⋯ 本身也不在(手机页头收起的搜索 / 文件夹还在 ⋯ 里)。
      expect(document.querySelector('[data-testid="chat-header-more-button"]') !== null).toBe(mobile)
      await clickElement(document.querySelector('[data-testid="chat-header-members-button"]') as HTMLElement)
      expect(onOpenInfo).toHaveBeenCalledWith('members')
    })
  }
})
