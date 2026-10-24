// @vitest-environment jsdom
//
// #6783 页头 ⋯ → 设置 只开这个聊天自己的设置(群设置 / 会话设置);私聊(含 agent 私聊)不再走 Agent 设置。
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function openMenuSettings(props: { isGroupChat: boolean; mobile: boolean }) {
  const onOpenSettingsDrawer = vi.fn()
  await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    ...props,
    isRoomChat: props.isGroupChat,
    searchMode: false,
    workspacePanelOpen: false,
    memberListOpen: false,
    showHeaderMenu: true,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onEnterSearchMode: vi.fn(),
    onOpenWorkspacePanel: vi.fn(),
    onCloseWorkspacePanel: vi.fn(),
    onOpenSettingsDrawer,
    onOpenMemberList: vi.fn(),
    onCloseRightSurfaces: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
    onOpenAnnouncement: vi.fn(),
  }), { chat: { activeChatId: 'g', chats: [{ id: 'g', kind: 'group' }] as never } })
  const item = document.querySelector('[data-testid="group-menu-settings"]') as HTMLElement | null
  expect(item).not.toBeNull()
  await clickElement(item!)
  return onOpenSettingsDrawer
}

describe('#6783 ⋯ → 设置 = 这个聊天自己的设置', () => {
  for (const mobile of [true, false]) {
    it(`私聊(${mobile ? '手机' : '桌面'}):打开会话设置`, async () => {
      expect(await openMenuSettings({ isGroupChat: false, mobile })).toHaveBeenCalledTimes(1)
    })
    it(`群聊(${mobile ? '手机' : '桌面'}):打开群设置`, async () => {
      expect(await openMenuSettings({ isGroupChat: true, mobile })).toHaveBeenCalledTimes(1)
    })
  }
})
