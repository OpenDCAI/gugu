// @vitest-environment jsdom
//
// #6792 手机群聊 ⋯ → 历史记录:打开历史面板时不带页签参数(由面板取默认页签)。
// 之前菜单项直接把 handler 当 onClick,点击事件被当成 initialTab 传进去,两个页签都对不上、正文空白。
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('#6792 ⋯ → 历史记录', () => {
  it('手机群聊:打开历史面板不带页签参数', async () => {
    const onOpenHistoryPanel = vi.fn()
    await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
      isGroupChat: true,
      isRoomChat: true,
      mobile: true,
      searchMode: false,
      workspacePanelOpen: false,
      memberListOpen: false,
      historyPanelOpen: false,
      showHeaderMenu: true,
      moreButtonRef: createRef<HTMLButtonElement>(),
      onEnterSearchMode: vi.fn(),
      onOpenWorkspacePanel: vi.fn(),
      onCloseWorkspacePanel: vi.fn(),
      onOpenSettingsDrawer: vi.fn(),
      onOpenMemberList: vi.fn(),
      onCloseRightSurfaces: vi.fn(),
      onOpenHistoryPanel,
      onCloseHistoryPanel: vi.fn(),
      onToggleHeaderMenu: vi.fn(),
      onCloseHeaderMenu: vi.fn(),
      onOpenAnnouncement: vi.fn(),
      onOpenConversationOrAgentSettings: vi.fn(),
    }), { chat: { activeChatId: 'g', chats: [{ id: 'g', kind: 'group' }] as never } })
    const item = Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes('历史记录')) as HTMLElement | undefined
    expect(item).toBeTruthy()
    await clickElement(item!)
    expect(onOpenHistoryPanel).toHaveBeenCalledTimes(1)
    expect(onOpenHistoryPanel).toHaveBeenCalledWith()
  })

  // #7197 手机 Agent 私聊页头最右多了模式按钮:同群聊的收法,历史收进 ⋯(四颗时 agent 名被挤成「Co…」);没有模式按钮照旧。
  it('手机 Agent 私聊有模式按钮:历史不在页头,在 ⋯ 里;没有模式按钮时仍在页头', async () => {
    const onOpenHistoryPanel = vi.fn()
    const props = (modeButton: boolean) => ({
      isGroupChat: false,
      isRoomChat: false,
      mobile: true,
      modeButton,
      searchMode: false,
      workspacePanelOpen: false,
      memberListOpen: false,
      historyPanelOpen: false,
      showHeaderMenu: true,
      moreButtonRef: createRef<HTMLButtonElement>(),
      onEnterSearchMode: vi.fn(),
      onOpenWorkspacePanel: vi.fn(),
      onCloseWorkspacePanel: vi.fn(),
      onOpenSettingsDrawer: vi.fn(),
      onOpenMemberList: vi.fn(),
      onCloseRightSurfaces: vi.fn(),
      onOpenHistoryPanel,
      onCloseHistoryPanel: vi.fn(),
      onToggleHeaderMenu: vi.fn(),
      onCloseHeaderMenu: vi.fn(),
      onOpenAnnouncement: vi.fn(),
    })
    const providers = { chat: { activeChatId: 'd', chats: [{ id: 'd', kind: 'dm' }] as never } }
    const headerHistory = () => document.querySelector('button[aria-pressed][aria-label="历史记录"]')
    const menuHistory = () => Array.from(document.querySelectorAll('[role="menuitem"]')).find((el) => el.textContent?.includes('历史记录')) as HTMLElement | undefined

    await renderWithAppProviders(harness, createNode(ChatHeaderActions, props(true)), providers)
    expect(headerHistory()).toBeNull()
    expect(menuHistory()).toBeTruthy()
    await clickElement(menuHistory()!)
    expect(onOpenHistoryPanel).toHaveBeenCalledWith()

    await renderWithAppProviders(harness, createNode(ChatHeaderActions, props(false)), providers)
    expect(headerHistory()).not.toBeNull()
    expect(menuHistory()).toBeUndefined()
  })
})
