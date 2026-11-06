// @vitest-environment jsdom
//
// #6783 页头只开这个聊天自己的信息(群信息 / 会话信息);私聊(含 agent 私聊)不走 Agent 设置。
// Settings must remain directly reachable after a change to the tab host (#249, #256, #439, #492).
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'
import { drainTopicSplitRequest } from '../../../../../apps/desktop/src/lib/topicSplitRequest'

vi.mock('@/lib/chatPinSettings', () => ({ readChatPinSettings: async () => ({ topicIds: [] }), setChatPinPreference: vi.fn(), watchChatPinSettings: () => () => {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

async function renderHeader(props: { isGroupChat: boolean; mobile: boolean }, extraChats: unknown[] = [], showHeaderMenu = true) {
  const onOpenInfo = vi.fn()
  await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    ...props,
    isRoomChat: props.isGroupChat,
    infoShown: false,
    showHeaderMenu,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onSearch: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenInfo,
    onCloseInfo: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
  }), { chat: { activeChatId: 'g', chats: [{ id: props.isGroupChat ? 'g' : 'd', kind: props.isGroupChat ? 'group' : 'dm' }, ...extraChats] as never } })
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
      expect(menuInfo()?.textContent).toBe('群信息与设置')
      expect(document.querySelector('[data-testid="chat-header-more-button"]')).not.toBeNull()
      await clickElement(menuInfo()!)
      expect(onOpenInfo).toHaveBeenCalledWith('main')
      expect(document.querySelector('[data-testid="group-menu-announcement"]')).toBeNull()
      await clickElement(document.querySelector('[data-testid="chat-header-members-button"]') as HTMLElement)
      expect(onOpenInfo).toHaveBeenCalledWith('members')
    })
  }

  it('phone group: no Topics button, the strip holds them', async () => {
    await renderHeader({ isGroupChat: true, mobile: true }, [{ id: 't-new', kind: 'topic', source_chat_id: 'g', name: '新话题', last_message_at: '2026-10-27T00:00:00Z' }], false)
    expect(document.querySelector('[data-testid="group-menu-topics"]')).toBeNull()
  })

  it('desktop group: direct Topics opens the same live topic list', async () => {
    await renderHeader({ isGroupChat: true, mobile: false }, [
      { id: 't-old', kind: 'topic', source_chat_id: 'g', name: '旧话题', last_message_at: '2026-10-01T00:00:00Z' },
      { id: 't-new', kind: 'topic', source_chat_id: 'g', name: '新话题', last_message_at: '2026-10-27T00:00:00Z' },
      { id: 't-else', kind: 'topic', source_chat_id: 'other', name: '别的群', last_message_at: '2026-10-27T00:00:00Z' },
    ], false)
    const topics = document.querySelector('[data-testid="group-menu-topics"]') as HTMLElement
    expect(topics.getAttribute('aria-label')).toBe('话题')
    await clickElement(topics)
    const rows = Array.from(document.querySelectorAll<HTMLElement>('[data-testid="group-menu-topic"]'))
    expect(rows.map((row) => row.querySelector('.gg-topic-name')?.textContent)).toEqual(['新话题', '旧话题'])
    await clickElement(rows[0]!)
    expect(drainTopicSplitRequest('g')).toMatchObject({ chatId: 't-new', sourceChatId: 'g' })
  })
})
