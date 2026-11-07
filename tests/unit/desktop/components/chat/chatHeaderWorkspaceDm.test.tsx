// @vitest-environment jsdom
//
// 主人 10-05「我发现私聊也是得有面板的呀」:私聊和群、话题一样有自己的文件夹和右栏。
// 主人 11-05:私聊的文件夹入口和群同一个位置、同一个图标 —— 都在 ⋯ 里(页签条「+」里也有),页头不再单放一颗按钮。
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

vi.mock('@/lib/chatPinSettings', () => ({ readChatPinSettings: async () => ({ topicIds: [] }), setChatPinPreference: vi.fn(), watchChatPinSettings: () => () => {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

const header = (props: { isGroupChat: boolean; isRoomChat: boolean; mobile: boolean }, onOpenFolder = vi.fn()) =>
  renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    ...props,
    infoShown: false,
    showHeaderMenu: true,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onSearch: vi.fn(),
    onOpenFolder,
    onOpenInfo: vi.fn(),
    onCloseInfo: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
  }), { chat: { activeChatId: 'c', chats: [{ id: 'c', kind: props.isGroupChat ? 'group' : 'dm' }] as never } }) // the item's name: useChatFolderName
const headerButton = () => harness.container.querySelector<HTMLElement>('button[aria-label="文件夹"], button[aria-label="群文件夹"]')
const menuItem = (name: string) => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((item) => item.textContent === name)

describe('a private chat reaches its folder where a group does', () => {
  it.each([[false, false], [false, true], [true, false], [true, true]])('mobile=%s, stale summary=%s: topic members use the source topic count', async (mobile, staleSummary) => {
    const onOpenInfo = vi.fn()
    const props = {
      isGroupChat: false, isRoomChat: false, mobile, infoShown: false, showHeaderMenu: false,
      moreButtonRef: createRef<HTMLButtonElement>(), onSearch: vi.fn(), onOpenFolder: vi.fn(),
      onOpenInfo, onCloseInfo: vi.fn(), onToggleHeaderMenu: vi.fn(), onCloseHeaderMenu: vi.fn(),
    }
    const render = (topic: boolean, count = staleSummary ? 3 : 2) => renderWithAppProviders(harness, createNode(ChatHeaderActions, {
      ...props, memberTopic: topic ? { topicChatId: 't', name: 'Topic' } : null, memberTopicCount: count,
    }), { chat: { activeChatId: 'c', chats: [chat({ id: 'c', kind: 'dm', member_user_ids: ['a', 'b', 'c'] }), ...(staleSummary ? [chat({ id: 't', kind: 'topic', member_user_ids: ['a', 'b', 'c', 'departed'] })] : [])] } })
    await render(true)
    const membersButton = () => harness.container.querySelector<HTMLElement>('[data-testid="chat-header-members-button"]')
    expect(membersButton()?.textContent).toBe(staleSummary ? '3' : '2')
    await clickElement(membersButton()!)
    expect(onOpenInfo).toHaveBeenCalledWith('members')
    await render(true, 1)
    expect(membersButton()?.textContent).toBe('1')
    await render(false)
    expect(membersButton()).toBeNull()
  })
  it.each([false, true])('mobile=%s: no header button; the ⋯ item opens the folder in the panel', async (mobile) => {
    const onOpen = vi.fn()
    await header({ isGroupChat: false, isRoomChat: false, mobile }, onOpen)
    expect(headerButton()).toBeNull()
    expect(menuItem('文件夹'), "owner 10-11: a private chat's is 文件夹").toBeDefined()
    await clickElement(menuItem('文件夹')!)
    expect(onOpen).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('mobile=%s: a group has the same ⋯ item and no header button', async (mobile) => {
    await header({ isGroupChat: true, isRoomChat: true, mobile })
    expect(headerButton()).toBeNull()
    expect(menuItem('群文件夹')).toBeDefined()
  })
})
