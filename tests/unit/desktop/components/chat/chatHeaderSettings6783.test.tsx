// @vitest-environment jsdom
//
// #6783 页头只开这个聊天自己的信息(群信息 / 会话信息);私聊(含 agent 私聊)不走 Agent 设置。
// Settings must remain directly reachable after a change to the tab host (#249, #256, #439, #492).
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
    it(`group (${mobile ? 'phone' : 'desktop'}): Settings opens the root; Members keeps its own direct destination`, async () => {
      const onOpenInfo = await renderHeader({ isGroupChat: true, mobile })
      expect(menuInfo()?.textContent).toBe('群设置')
      expect(document.querySelector('[data-testid="chat-header-more-button"]')).not.toBeNull()
      await clickElement(menuInfo()!)
      expect(onOpenInfo).toHaveBeenCalledWith('main')
      expect(document.querySelector('[data-testid="group-menu-announcement"]')).toBeNull()
      await clickElement(document.querySelector('[data-testid="chat-header-members-button"]') as HTMLElement)
      expect(onOpenInfo).toHaveBeenCalledWith('members')
    })
  }
})
