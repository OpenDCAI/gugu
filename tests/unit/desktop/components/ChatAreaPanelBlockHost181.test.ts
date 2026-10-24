// @vitest-environment jsdom
// gugu-dev#181 群聊画在会话页一块里(blockHost):块的页签条就是头 —— 这里不画群聊头,头上那排图标画进页签条右端那一格,
// 对话的头像和名字画进页签那一格,人数挂在成员按钮上。不给 blockHost(对话页、手机、网页)时头栏照旧:每条带这个阳性对照。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { composerSlotClass, composerSlotInnerClass, composerSlotInnerBottomClass } from '@gugu/session-chat-ui/composer-layout'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { requestShellChatAction } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { chat, clickElement, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { InChatSlot } from '../../../../apps/desktop/src/lib/shellSlots'
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
  it('an empty project keeps its home in the chat column while group settings can open beside it', async () => {
    publishChatSummaries([{ id: 'group-1', kind: 'group', name: 'Settings project', last_message_at: null }])
    await renderPanel({ actions, title, tabs: null }, 'group', false, true)
    const home = harness.container.querySelector('[data-chat-part="empty"]')
    expect(home, 'the project home has a place inside the same conversation surface').not.toBeNull()
    await clickElement(actions.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderMoreButton}"]`)!)
    await clickElement(document.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.groupMenuSettings}"]`)!)
    expect(harness.container.querySelector('[data-testid="chat-settings-panel"]')).not.toBeNull()
    expect(harness.container.contains(home)).toBe(true)
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

  for (const layout of ['header', 'block', 'phone'] as const) {
    for (const kind of ['group', 'dm', 'ai'] as const) {
      it(`${layout} ${kind}: More opens this conversation's settings without installed or pinned Apps`, async () => {
        const hosted = layout === 'block'
        await renderPanel(hosted ? { actions, title, tabs: null } : undefined, kind, layout === 'phone')
        const more = (hosted ? actions : harness.container).querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderMoreButton}"]`)
        expect(more, 'settings have a visible menu trigger in every layout').not.toBeNull()
        await clickElement(more!)
        const settings = document.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.groupMenuSettings}"]`)
        expect(settings).not.toBeNull()
        await clickElement(settings!)
        expect(harness.container.querySelector('[data-testid="chat-settings-panel"]')).not.toBeNull()
      })
    }
  }

  it('a tab menu asks one chat for its settings: only that chat\'s panel opens them', async () => {
    await renderPanel({ actions, title, tabs: null })
    const before = harness.container.textContent?.length ?? 0
    await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatDetailsDrawer, { detail: { chatId: 'another-group', page: 'settings' } })) })
    expect(harness.container.textContent?.length, 'another chat was named: this panel stays as it was').toBe(before)
    await act(async () => { window.dispatchEvent(new CustomEvent(UI_EVENTS.openChatDetailsDrawer, { detail: { chatId: 'group-1', page: 'settings' } })) })
    expect(harness.container.textContent?.length ?? 0, 'its own chat was named: the settings open').toBeGreaterThan(before)
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
    expect(dock.firstElementChild?.classList.contains(composerSlotInnerClass)).toBe(true)
    expect(dock.firstElementChild?.classList.contains(composerSlotInnerBottomClass)).toBe(true)
  })

  it('in a block the group tab gives the chat the room: the panel goes, its tab stays and brings it back (第 ⑥ 步)', async () => {
    const tabs = document.body.appendChild(document.createElement('span'))
    await renderPanel({ actions, title, tabs })
    await act(async () => { tabs.querySelector<HTMLButtonElement>('[data-testid="block-panel-plus"]')!.click() })
    await act(async () => { document.querySelector<HTMLElement>('[role="menuitem"]')!.click() })
    // 右栏收起时要等动画放完才卸下(SidePanelSplit),jsdom 里不放动画 ⇒ 判「正显示」看那一枚亮不亮(读的是同一份右栏样子)。
    const folderTab = () => tabs.querySelector<HTMLElement>('[data-panel-tab="folder"] [data-tab-label]')
    const shown = () => folderTab()?.hasAttribute('data-tab-active')
    expect(harness.container.querySelector('[data-testid="group-app-slot"]'), 'the folder picked from「+」is up').not.toBeNull()
    expect(shown()).toBe(true)
    expect(harness.container.querySelector('[data-testid="group-app-slot-close"]'), 'in a block the tab is its title and its ×').toBeNull()
    await act(async () => { requestShellChatAction({ kind: 'show-chat-alone', chatId: 'another-group' }) })
    expect(shown(), 'another chat\'s tab: this panel stays').toBe(true)
    await act(async () => { requestShellChatAction({ kind: 'show-chat-alone', chatId: 'group-1' }) })
    expect(folderTab(), 'its own group tab: the right side gives way, the folder stays open').not.toBeNull()
    expect(shown(), 'not shown').toBe(false)
    await act(async () => { folderTab()!.click() })
    expect(shown(), 'its tab brings it back').toBe(true)
    tabs.remove()
  })

  it('in a block whose slots are not mounted yet still draws no header', async () => {
    await renderPanel({ actions: null, title: null, tabs: null })
    expect(header()).toBeNull()
    expect(membersButtonIn(harness.container)).toBeNull()
  })
})
