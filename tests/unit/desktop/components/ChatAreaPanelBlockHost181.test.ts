// @vitest-environment jsdom
// gugu-dev#181 群聊画在会话页一块里(blockHost):块的页签条就是头 —— 这里不画群聊头,头上那排图标画进页签条右端那一格,
// 对话的头像和名字画进页签那一格,人数挂在成员按钮上。不给 blockHost(对话页、手机、网页)时头栏照旧:每条带这个阳性对照。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { composerSlotClass, composerSlotInnerClass } from '@gugu/session-chat-ui/composer-layout'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { chat, clickElement, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { chatTabSlotKey, InChatSlot, installShellSlots, readShellSlots } from '../../../../apps/desktop/src/lib/shellSlots'
import { isFolderItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { closeChatTab, closeInfoTab, focusedChatTab, infoTabOf, openInfoTab, panelTabsOf, showChatOnly, showChatTab, shownPanelTab } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { publishChatSummaries } from '../../../../apps/desktop/src/lib/chatSummariesBridge'

const { getImRepositoryMock } = vi.hoisted(() => ({ getImRepositoryMock: vi.fn() }))

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    createTopic: vi.fn(),
    listTopicsOfChat: vi.fn(async () => []),
    getSourceState: vi.fn(async () => ({ kind: 'gone' as const })),
    getAgentFloodAdjustment: vi.fn(async () => null),
    undoAgentFloodAdjustment: vi.fn(async () => 0),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: vi.fn(async () => []),
    getGroupCollab: vi.fn(async () => ({
      snapshot: {
        scheduler: { chat_id: 'group-1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-10-22T00:00:00.000Z' },
        humans: [
          { id: 'user-1', role: 'owner', type: 'human', account_status: null },
          { id: 'user-2', role: 'member', type: 'human', account_status: null },
        ],
        agents: [], tasks: [], outputs: [],
      },
      identities: [],
    })),
    markMessageRead: vi.fn(async () => {}),
    getOtherMembersReadSeqs: vi.fn(async () => ({})),
    getThreadMessages: vi.fn(async () => []),
    getGroupChatSettings: vi.fn(async () => ({ chat_id: 'group-1', max_members: 500, allow_member_invite: true, invite_link_enabled: false, agent_join_approval: false, join_mode: 'open', group_prompt: null, description: null, public_id: null, join_token: null })),
    listGroupJoinRequests: vi.fn(async () => []),
  },
}))

let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository
let actions: HTMLElement
let title: HTMLElement

beforeEach(async () => {
  harness = createReactHarness()
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
  actions = document.body.appendChild(document.createElement('span'))
  title = document.body.appendChild(document.createElement('span'))
})

afterEach(() => {
  repository.close()
  harness.cleanup()
  actions.remove()
  title.remove()
})

async function renderPanel(blockHost?: { actions: HTMLElement | null; title: HTMLElement | null; tabs: HTMLElement | null }, kind: 'group' | 'dm' | 'ai' = 'group', mobile = false, project = false) {
  const panel = createNode(ChatAreaPanel, { activeTab: 'chats', openNonce: 0, blockHost, mobile })
  await renderWithAppProviders(harness, project ? createNode(InChatSlot.Provider, { value: { projectName: 'Settings project' } }, panel) : panel, {
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: 'group-1',
      activeChat: chat({ id: 'group-1', kind, name: '设计评审' }),
      identitiesById: { 'user-1': displayIdentity('user-1'), 'user-2': displayIdentity('user-2') },
      messages: [],
    },
  })
}

const header = () => harness.container.querySelector('[data-chat-area-header]')
const membersButtonIn = (root: ParentNode) => root.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderMembersButton}"]`)

describe('ChatAreaPanel hosted in a block (gugu-dev#181)', () => {
  it('an empty project keeps its home in the chat column while its info opens beside it', async () => {
    publishChatSummaries([{ id: 'group-1', kind: 'group', name: 'Settings project', last_message_at: null }])
    try {
      await renderPanel({ actions, title, tabs: null }, 'group', false, true)
      const home = harness.container.querySelector('[data-chat-part="empty"]')
      expect(home, 'the project home has a place inside the same conversation surface').not.toBeNull()
      await clickElement(membersButtonIn(actions) as HTMLElement)
      expect(infoTabOf('group-1')?.shown, 'the group info is a tab beside the chat').toBe(true)
      expect(harness.container.contains(home)).toBe(true)
    } finally {
      await act(async () => { closeInfoTab('group-1') })
    }
  })
  it('without blockHost keeps its own header with the title and the action icons', async () => {
    await renderPanel()
    expect(header(), 'chat page / phone / web: the header row is still there').not.toBeNull()
    expect(header()?.textContent).toContain('设计评审')
    expect(membersButtonIn(header()!)).not.toBeNull()
    expect(harness.container.querySelector('[data-member-count]'), 'the count stays after the title, not on the button').toBeNull()
  })

  it('in a block draws no header; the icons go to the tab strip slot and the name to the tab slot', async () => {
    await renderPanel({ actions, title, tabs: null })
    expect(header(), 'the block tab strip is the header').toBeNull()
    expect(membersButtonIn(actions), 'the action icons are painted into the tab strip').not.toBeNull()
    expect(actions.querySelector('[data-member-count]')?.textContent).toBe('2')
    expect(title.textContent).toContain('设计评审')
  })

  // owner 10-26:成员、公告、设置合成一枚「群信息」页签。群从成员钮进(落在成员那一页),私聊从 ⋯ 进;每种形态都打得开。
  for (const layout of ['header', 'block', 'phone'] as const) {
    for (const kind of ['group', 'dm', 'ai'] as const) {
      it(`${layout} ${kind}: this conversation's info opens without installed or pinned Apps`, async () => {
        const hosted = layout === 'block'
        try {
          await renderPanel(hosted ? { actions, title, tabs: null } : undefined, kind, layout === 'phone')
          const root = hosted ? actions : harness.container
          if (kind === 'group') {
            await clickElement(membersButtonIn(root) as HTMLElement)
          } else {
            const more = root.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderMoreButton}"]`)
            expect(more, 'a private chat reaches its info from More').not.toBeNull()
            await clickElement(more!)
            await clickElement(document.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.groupMenuSettings}"]`)!)
          }
          expect(infoTabOf('group-1')?.info.page).toBe(kind === 'group' ? 'members' : undefined)
          // Without a strip the tab in front is a page over the chat; in a block it is drawn into its slot (below).
          if (!hosted) expect(harness.container.querySelector('[data-testid="chat-settings-panel"]')).not.toBeNull()
        } finally {
          await act(async () => { closeInfoTab('group-1') })
        }
      })
    }
  }

  it('in a block the info tab is drawn into the slot its strip left, and only its own chat opens it', async () => {
    const slot = document.body.appendChild(document.createElement('div'))
    installShellSlots()
    try {
      await renderPanel({ actions, title, tabs: null })
      await act(async () => { openInfoTab('another-group') })
      expect(infoTabOf('group-1'), 'another chat was named: this chat has no info tab').toBeNull()
      await act(async () => { openInfoTab('group-1') })
      const info = infoTabOf('group-1')!
      expect(info.shown).toBe(true)
      await act(async () => { readShellSlots()!.setSlot(chatTabSlotKey('group-1', info.tabId), slot) })
      expect(slot.querySelector('[data-testid="chat-settings-panel"]')).not.toBeNull()
      expect(slot.querySelector('[aria-label="关闭"]'), 'the tab is its title and its ×').toBeNull()
    } finally {
      await act(async () => {
        const info = infoTabOf('group-1')
        if (info) readShellSlots()?.setSlot(chatTabSlotKey('group-1', info.tabId), null)
        closeInfoTab('group-1')
        closeInfoTab('another-group')
      })
      slot.remove()
    }
  })

  it('in a block the strip gets the「+」for the group folder and Apps (第 ⑥ 步); the chat page has no strip and none', async () => {
    const tabs = document.body.appendChild(document.createElement('span'))
    await renderPanel({ actions, title, tabs })
    expect(tabs.querySelector('[data-testid="block-panel-plus"]')).not.toBeNull()
    expect(tabs.querySelector('[data-panel-tab]'), 'the panel is closed: no tabs for it').toBeNull()
    tabs.remove()
    await renderPanel()
    expect(document.querySelector('[data-testid="block-panel-plus"]')).toBeNull()
    expect(document.querySelector('[data-panel-tab]')).toBeNull()
  })

  it.each([false, true])('uses one ACP desktop frame with no duplicate host padding (block=%s)', async (block) => {
    await renderPanel(block ? { actions, title, tabs: null } : undefined)
    const composer = harness.container.querySelector<HTMLElement>('[data-chat-composer]')!
    expect(composer.className).toBe('')
    expect(composer.style.padding).toBe('0px')
    const dock = composer.closest('[data-chat-bottom-dock]')!
    expect(dock.classList.contains(composerSlotClass)).toBe(true)
    // 回复条 + 输入框那一层:同一个 ACP 框,自己没有底(owner 10-25),底只在卡上。
    const layer = dock.lastElementChild!
    expect(layer.contains(composer)).toBe(true)
    expect(layer.classList.contains(composerSlotInnerClass)).toBe(true)
    expect(layer.className).not.toMatch(/\bbg-/)
  })

  // owner 10-25:运行条那一行在可能有 agent 跑的会话里始终占位(固定高、没有底),所以运行条出现、消失不改变布局;
  // 底部那一摞浮在消息流上,消息从它后面滚过。和真人的私聊没有运行条,不留这一行。
  it.each([['group', true], ['ai', true], ['dm', false]] as const)('reserves the running bar row in a %s chat: %s', async (kind, reserved) => {
    await renderPanel(undefined, kind)
    const dock = harness.container.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
    expect(dock.classList.contains('absolute!')).toBe(true)
    const row = dock.querySelector('[data-running-bar-slot]')
    expect(row !== null).toBe(reserved)
    if (row) expect(dock.firstElementChild!.contains(row)).toBe(true)
  })

  it('in a block「+」opens the folder as a tab beside the chat, drawn into the slot its strip left (第 ⑥ 步)', async () => {
    const tabs = document.body.appendChild(document.createElement('span'))
    const slot = document.body.appendChild(document.createElement('div'))
    installShellSlots()
    let folder: string | undefined
    try {
      await renderPanel({ actions, title, tabs })
      await act(async () => { tabs.querySelector<HTMLButtonElement>('[data-testid="block-panel-plus"]')!.click() })
      await act(async () => { document.querySelector<HTMLElement>('[role="menuitem"]')!.click() })
      const shown = shownPanelTab('group-1')
      expect(isFolderItem(shown?.item), 'the folder picked from「+」is up beside the chat').toBe(true)
      folder = shown!.tabId
      // The session page's engine leaves a slot for each tab on screen (chat-tab-providers' ShellTabSlots).
      await act(async () => { readShellSlots()!.setSlot(chatTabSlotKey('group-1', folder!), slot) })
      expect(slot.querySelector('[data-testid="group-app-slot"]')).not.toBeNull()
      expect(slot.querySelector('[data-testid="group-app-slot-close"]'), 'in a block the tab is its title and its ×').toBeNull()
      await act(async () => { showChatOnly('another-group') })
      expect(focusedChatTab('group-1')?.tabId, 'another chat\'s tab: this one stays').toBe(folder)
      await act(async () => { showChatOnly('group-1') })
      expect(focusedChatTab('group-1')?.kind, 'its own chat\'s tab: the chat is focused').toBe('chat')
      expect(panelTabsOf('group-1').some((tab) => tab.tabId === folder), 'the folder stays open').toBe(true)
      await act(async () => { showChatTab('group-1', folder!) })
      expect(focusedChatTab('group-1')?.tabId, 'its tab brings it back').toBe(folder)
    } finally {
      await act(async () => {
        readShellSlots()?.setSlot(chatTabSlotKey('group-1', folder ?? ''), null)
        if (folder) closeChatTab('group-1', folder)
      })
      slot.remove()
      tabs.remove()
    }
  })

  it('in a block whose slots are not mounted yet still draws no header', async () => {
    await renderPanel({ actions: null, title: null, tabs: null })
    expect(header()).toBeNull()
    expect(membersButtonIn(harness.container)).toBeNull()
  })
})
