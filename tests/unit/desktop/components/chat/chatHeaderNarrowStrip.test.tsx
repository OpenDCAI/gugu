// @vitest-environment jsdom
//
// 会话页里一块的页签条窄了(TabStripShell 的 data-strip-narrow):群头那排钮顶出这一块(10-28 实测:窗口 800、两块并排,
// 一块 247px,群 Apps / 搜索 / 文件夹 / 成员 / ⋯ / 关闭约 211px,伸进旁边那块)。窄了以后同手机那套:
// 群 Apps / 搜索 / 文件夹收进 ⋯,成员与 ⋯ 留在头上;条变宽,钮回到头上。
import { act, createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness, renderWithAppProviders } from '../../../../support/testHarness'
import { ChatHeaderActions } from '../../../../../apps/desktop/src/components/chat/ChatHeaderActions'

vi.mock('@/lib/chatPinSettings', () => ({ readChatPinSettings: async () => ({ topicIds: [] }), setChatPinPreference: vi.fn(), watchChatPinSettings: () => () => {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  harness.container.className = 'session-tab-bar'
})
afterEach(() => harness.cleanup())

async function renderHeader({ narrow, showHeaderMenu }: { narrow: boolean; showHeaderMenu: boolean }) {
  if (narrow) harness.container.setAttribute('data-strip-narrow', '')
  await renderWithAppProviders(harness, createNode(ChatHeaderActions, {
    isGroupChat: true,
    isRoomChat: true,
    infoShown: false,
    showHeaderMenu,
    moreButtonRef: createRef<HTMLButtonElement>(),
    onSearch: vi.fn(),
    onOpenFolder: vi.fn(),
    onOpenInfo: vi.fn(),
    onCloseInfo: vi.fn(),
    onToggleHeaderMenu: vi.fn(),
    onCloseHeaderMenu: vi.fn(),
  }), { chat: { activeChatId: 'g', chats: [{ id: 'g', kind: 'group' }] as never } })
}

const onHeader = () => [...harness.container.querySelectorAll<HTMLElement>('button[aria-label]')].map((el) => el.getAttribute('aria-label'))
const inMenu = () => [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].map((el) => el.textContent)

describe('a group header in a narrow tab strip', () => {
  it('narrow: Topics stays by members; Apps, search and the folder are in More', async () => {
    await renderHeader({ narrow: true, showHeaderMenu: true })
    expect(onHeader()).not.toContain('应用')
    expect(onHeader()).not.toContain('在对话中搜索')
    expect(onHeader()).not.toContain('文件')
    expect(onHeader()).toContain('成员列表')
    expect(onHeader()).toContain('话题')
    expect(onHeader()).toContain('更多操作')
    expect(inMenu()).toEqual(expect.arrayContaining(['搜索聊天记录⌘F', '文件', '应用']))
  })

  it('wide: Apps returns as the strip widens; search and folder stay inside More', async () => {
    await renderHeader({ narrow: false, showHeaderMenu: false })
    expect(onHeader()).toEqual(expect.arrayContaining(['应用', '话题', '成员列表', '更多操作']))
    expect(onHeader()).not.toContain('在对话中搜索')
    expect(onHeader()).not.toContain('文件')
    await act(async () => { harness.container.setAttribute('data-strip-narrow', '') })
    expect(onHeader()).not.toContain('应用')
    expect(onHeader()).not.toContain('文件')
    await act(async () => { harness.container.removeAttribute('data-strip-narrow') })
    expect(onHeader()).toEqual(expect.arrayContaining(['应用', '话题']))
  })
})
