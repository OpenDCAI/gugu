// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readComposer } from '../../../support/composerEditor'
import { createElement } from 'react'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import type { Device, MessageItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { chat, clickElement, createNode, createReactHarness, device as testDevice, displayIdentity, fireContextMenu, message as messageItem, renderWithAppProviders } from '../../../support/testHarness'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import type { AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { presentationOfDisplayStatus } from '../../../support/agentDisplayStatusTestDouble'
import type { ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { drainTopicSplitRequest } from '../../../../apps/desktop/src/lib/topicSplitRequest'


vi.mock('../../../../apps/desktop/src/components/chat/AgentDmConversation', () => ({
  AgentDmConversation: ({ chat }: { chat: { peer_user_id?: string } }) => createElement('div', { 'data-testid': 'agent-dm-conversation', 'data-agent-user-id': chat.peer_user_id }),
}))

// @@@store-status-mock - Overridable so tests can flip the store's reported status independently of the
const presenceMock = vi.hoisted(() => ({
  status: 'idle' as 'idle' | 'working' | 'offline' | 'removed',
  recentActions: [] as string[],
  lastActionAt: null as string | null,
}))

// @@@1506 - group running status is presence-driven (GroupAgentStatusBar reads groupCollab agents +
// useAgentDisplayStatuses). Overridable so the group test can stand up a running agent.
const groupMock = vi.hoisted(() => ({
  agents: [] as unknown[],
  statuses: {} as Record<string, string>,
}))

const { getImRepositoryMock } = vi.hoisted(() => ({ getImRepositoryMock: vi.fn() }))

function devicesStore(devices: Device[]): DevicesContextValue {
  return {
    devices,
    loading: false,
    error: null,
    refresh: vi.fn(async () => {}),
    rename: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    listBoundAgents: vi.fn(async () => []),
  }
}

const topicServiceMock = vi.hoisted(() => ({
  createTopic: vi.fn(async () => ({
    chat_id: 'topic-1', public_id: 9001, name: '登录超时这个问题到底怎么修',
    source_chat_id: 'chat-1', source_message_id: 'msg-1', creator_user_id: 'me',
  })),
  listTopicsOfChat: vi.fn(async () => []),
  getSourceState: vi.fn(async () => ({ kind: 'gone' as const })),
  getAgentFloodAdjustment: vi.fn(async () => null),
  undoAgentFloodAdjustment: vi.fn(async () => 0),
}))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({ topicService: topicServiceMock }))


vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    // @@@5856 话题分栏是**另一条 chat**,它自己拉自己的消息 —— 所以这份 mock 必须给 getMessages,
    // 否则分栏一挂载就抛(而抛出的位置在 effect 里,表现成「面板没出来」,很容易误读成入口没接上)。
    getMessages: vi.fn(async () => []),
    getGroupCollab: vi.fn(async () => ({
      snapshot: {
        scheduler: {
          chat_id: 'chat-1',
          paused: false,
          queue_count: 0,
          blocked_count: 0,
          summary: null,
          updated_at: '2026-05-09T00:00:00.000Z',
        },
        humans: [],
        agents: groupMock.agents,
        tasks: [],
        outputs: [],
      },
      // 名册与身份同源同出(#5610):写入侧断言要求名册成员都带身份,这里按 groupMock 给全。
      identities: (groupMock.agents as Array<{ id: string; display_name: string; avatar?: string | null; owner_user_id?: string | null }>).map((agent) => ({
        id: agent.id, type: 'agent', display_name: agent.display_name, avatar: agent.avatar ?? null, gugu_number: null, bio: null,
        owner_user_id: agent.owner_user_id === undefined ? 'user-1' : agent.owner_user_id, agent_public: null, desired_status: null, device_id: null, category: null, is_official: null,
        local_path: null, created_at: null, updated_at: null,
      })),
    })),
    getThreadMessages: vi.fn(async () => []),
    // The chat surface reads the viewer's authority from the server projection (group_info_as).
    getGroupChatSettings: vi.fn(async () => ({ id: 'chat-1', my_role: 'member', can_manage: false, can_dissolve: false, can_archive_topic: false, allow_member_invite: false })),
  },
}))

vi.mock('../../../../apps/desktop/src/hooks/useAgentDisplayStatus', () => ({
  useAgentDisplayStatus: () => ({
    status: presenceMock.status,
    // @@@agent-engine (#994b) - parsed presence payload 恒带 deviceId(位置) + agentType(引擎)；header 据此拼「状态 · 本机 · Claude Code」。
    presence: { presentation: presentationOfDisplayStatus(presenceMock.status), payload: { deviceId: 'device-1', agentType: 'claude-code', recentActions: presenceMock.recentActions, lastActionAt: presenceMock.lastActionAt, updatedAt: new Date().toISOString() } },
    waking: false,
    wake: vi.fn(),
    opening: false,
    openRuntime: vi.fn(),
  }),
  useAgentDisplayStatuses: () => groupMock.statuses,
  useAgentRecentActivity: () => ({}),
}))

let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository

beforeEach(async () => {
  harness = createReactHarness()
  presenceMock.status = 'idle'
  presenceMock.recentActions = []
  presenceMock.lastActionAt = new Date().toISOString()
  groupMock.agents = []
  groupMock.statuses = {}
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
})

afterEach(() => {
  repository.close()
  harness.cleanup()
})

describe('ChatAreaPanel agent activity placement', () => {
  // @@@1506 - owner: running 状态轻量浮动文字、在输入框上方（不再是消息列表内的最后一行 #1102）。
  // DM 的「运行中」从 in-list 移到 composer 上方的 agent-running-status 浮动条；流式正文仍留消息流。
  // 它显不显、显什么,只看那张 agent 表说这个 agent 在不在跑 —— ❌ 没有第二个来源可以让它单独亮或单独灭。
  it('routes agent DMs to the unified conversation instead of the IM list', async () => {
    await renderChatArea({ activeChat: chat({ id: 'chat-1', kind: 'ai', name: 'Agent', peer_user_id: 'agent-1' }), messages: [mineMessage({})] })
    expect(harness.container.querySelector('[data-testid="agent-dm-conversation"]')?.getAttribute('data-agent-user-id')).toBe('agent-1')
    expect(harness.container.querySelector('[data-testid="agent-running-status"]')).toBeNull()
    expect(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatMessageList}"]`)).toBeNull()
  })

  // 对话头的名字与对话列表、⌘K 面板、「来自 X」同一个函数(chatDisplayName):私聊写对方,备注优先。
  it('names the chat header the way chatDisplayName names the chat', async () => {
    const dm = chat({ id: 'chat-1', kind: 'dm', name: 'Wei Zhang', peer_user_id: 'peer-1', peer_alias: '阿威' })
    await renderChatArea({ activeChat: dm, messages: [] })
    const header = harness.container.querySelector('[data-chat-area-header]')
    expect(chatDisplayName(dm, 'Wei Zhang')).toBe('阿威')
    expect(header?.textContent).toContain(chatDisplayName(dm, 'Wei Zhang'))
  })

  // One row on every device (#951): my agents lead the visible row, the rest sit behind +N, all still mention targets.
  it('prioritizes my agents in the one-row strip and keeps every mention target behind +N (#6008)', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360)
    const pill = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
      return this.matches('.rtb-more') ? 32 : this.matches('[data-message-preview-trigger]') ? 100 : 0
    })
    groupMock.agents = ['other-1', 'other-2', 'mine-1', 'mine-2', 'mine-3', 'mine-4', 'mine-idle'].map((id) => ({
      id, display_name: id, type: 'agent', role: 'member', account_status: 'active', avatar: null, email: null,
      owner_user_id: id.startsWith('mine-') ? 'user-1' : 'user-2',
    }))
    groupMock.statuses = {
      'other-1': 'working', 'other-2': 'working', 'mine-1': 'working', 'mine-2': 'working',
      'mine-3': 'working', 'mine-4': 'working', 'mine-idle': 'idle',
    }
    await renderChatArea({ activeChat: chat({ id: 'chat-1', kind: 'group', name: 'Team' }), messages: [] })

    try {
      const runningBar = harness.container.querySelector('[data-testid="group-agent-running-status"]')!
      const names = (root: ParentNode, selector: string) => Array.from(root.querySelectorAll<HTMLElement>(selector), (node) => node.querySelector('.rtb-nm')!.textContent)
      // 360px fits three 100px pills plus +N.
      expect(Array.from(runningBar.querySelectorAll<HTMLElement>('.rtb-bar > [data-message-preview-trigger]')).filter((node) => node.style.visibility !== 'hidden').map((node) => node.querySelector('.rtb-nm')!.textContent)).toEqual(['mine-1', 'mine-2', 'mine-3'])
      expect(runningBar.querySelector('.rtb-more')?.textContent).toBe('+3')
      await clickElement(runningBar.querySelector<HTMLButtonElement>('.rtb-more')!)
      const panel = document.body.querySelector('.rtb-ov')!
      expect(Array.from(panel.querySelectorAll('[role="group"]'), (group) => [group.getAttribute('aria-label'), names(group, '[data-message-preview-trigger]')])).toEqual([['我的', ['mine-4']], ['其他人的', ['other-1', 'other-2']]])
      await clickElement(panel.querySelector<HTMLButtonElement>('[data-message-preview-trigger="mine-4"]')!)
      expect(readComposer(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`))).toContain('@mine-4')
    } finally {
      width.mockRestore()
      pill.mockRestore()
    }
  })

  it.each([
    ['pending', {}, 'active', '确认中'],
    ['offline', { 'agent-1': 'offline' }, 'active', '不在线'],
    ['removed', { 'agent-1': 'removed' }, 'removed', '已移除'],
    ['working', { 'agent-1': 'working' }, 'active', '运行中'],
    // #6448 同一张表:后台在跑、需要你、出错在群头也是那一句。
    ['parked', { 'agent-1': 'parked' }, 'active', '后台运行中'],
    ['needs_user', { 'agent-1': 'needs_user' }, 'active', '需要你处理'],
    ['error', { 'agent-1': 'error' }, 'active', '出错了'],
  ] as Array<[string, Record<string, string>, string, string]>)('uses the resolved %s group status in the accessible header indicator', async (status, statuses, accountStatus, label) => {
    groupMock.agents = [{ id: 'agent-1', display_name: 'Status Bot', type: 'agent', role: 'member', account_status: accountStatus, avatar: null, email: null }]
    groupMock.statuses = statuses

    await renderChatArea({
      activeChat: chat({ id: 'chat-1', kind: 'group', name: 'Ops' }),
      messages: [],
    })

    const indicator = harness.container.querySelector(`[data-agent-display-status="${status}"]`)
    expect(indicator).not.toBeNull()
    expect(indicator?.getAttribute('role')).toBe('img')
    expect(indicator?.getAttribute('aria-hidden')).toBeNull()
    expect(indicator?.getAttribute('aria-label')).toBe(label)
  })

  it('reloads group collab when the same chat is reopened on mobile (openNonce bump) (#461)', async () => {
    const groupChat = chat({ id: 'chat-1', kind: 'group', name: 'Ops' })
    vi.mocked(chatService.getGroupCollab).mockClear()

    await renderWithAppProviders(harness, createNode(ChatAreaPanel, { openNonce: 0 }), {
      chat: { getImRepository: getImRepositoryMock, activeChatId: 'chat-1', activeChat: groupChat, messages: [] },
    })
    const before = vi.mocked(chatService.getGroupCollab).mock.calls.length
    expect(before).toBeGreaterThanOrEqual(1)

    // Reopening the SAME chat on mobile bumps openNonce without changing activeChatId — the reset clears the
    // collab snapshot, so the load effect must refire to refill it (the #461 asymmetry this guards).
    await renderWithAppProviders(harness, createNode(ChatAreaPanel, { openNonce: 1 }), {
      chat: { getImRepository: getImRepositoryMock, activeChatId: 'chat-1', activeChat: groupChat, messages: [] },
    })
    expect(vi.mocked(chatService.getGroupCollab).mock.calls.length).toBeGreaterThan(before)
  })

  it('coalesces a burst of collab triggers into a single refetch (#597)', async () => {
    // A group-open used to fire one full getGroupCollab PER trigger (realtime event ×3 + onSubscribed +
    // local event), storming the backend. They now funnel through one coalesced settle-delayed refetch:
    // a whole burst collapses to ONE extra getGroupCollab, on top of the single immediate open-load.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      let onChange: AccountRevisionListener = () => {}
      // 认领可以是一个 event 或一组(revision-dispatch:按 registration 派发)。
      const subscribeAccountRevision = vi.fn((events: string | readonly string[], listener: typeof onChange) => {
        const claimed = typeof events === 'string' ? [events] : [...events]
        if (claimed.includes('group_collab_changed')) onChange = listener
        return () => undefined
      })
      vi.mocked(chatService.getGroupCollab).mockClear()

      await renderWithAppProviders(harness, createNode(ChatAreaPanel, { openNonce: 0 }), {
        chat: { getImRepository: getImRepositoryMock, subscribeAccountRevision, activeChatId: 'chat-1', activeChat: chat({ id: 'chat-1', kind: 'group', name: 'Ops' }), messages: [] },
      })
      const afterOpen = vi.mocked(chatService.getGroupCollab).mock.calls.length
      expect(afterOpen).toBeGreaterThanOrEqual(1)

      const operation = { revision: '1', event: 'group_collab_changed', payload: { chat_id: 'chat-1' } }
      onChange([operation])
      onChange([operation])
      onChange([operation])
      onChange([operation])
      // Nothing fires synchronously — the coalesce holds a single pending refetch.
      expect(vi.mocked(chatService.getGroupCollab).mock.calls.length).toBe(afterOpen)

      await vi.advanceTimersByTimeAsync(350)
      // The entire burst collapsed into exactly one refetch.
      expect(vi.mocked(chatService.getGroupCollab).mock.calls.length).toBe(afterOpen + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses public Gugu numbers in direct chat message profile popovers', async () => {
    await renderWithAppProviders(
      harness,
      createNode(ChatAreaPanel, {}),
      {
        auth: { id: 'owner-1', email: 'owner@example.com', nickname: 'Owner', gugu_number: 100001 },
        chat: {
          activeChatId: 'chat-1',
          activeChat: chat({
            id: 'chat-1',
            kind: 'dm',
            name: 'Peer Public',
            peer_user_id: 'peer-1',
            avatar: 'https://db.example/storage/v1/object/public/avatars/fixture-owner.fixture-agent.png',
          }),
          messages: [
            messageItem({
              id: 'msg-owner', sender_user_id: 'owner-1', content: 'owner', is_mine: true, seq: 1,
            }),
            messageItem({
              id: 'msg-peer', sender_user_id: 'peer-1', content: 'peer', is_mine: false, seq: 2,
            }),
          ],
          identitiesById: {
            'owner-1': displayIdentity('owner-1', { display_name: 'Owner', gugu_number: 100001 }),
            'peer-1': displayIdentity('peer-1', { display_name: 'Peer Public', gugu_number: 100222 }),
          },
        },
      },
    )

    const ownAvatar = document.body.querySelector('[data-message-sender-id="owner-1"]') as HTMLButtonElement | null
    expect(ownAvatar).not.toBeNull()
    await clickElement(ownAvatar!)
    expect(document.body.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.messageAvatarProfileMenu}"]`)?.textContent).toContain('100001')

    await clickElement(ownAvatar!)
    const peerAvatar = document.body.querySelector('[data-message-sender-id="peer-1"]') as HTMLButtonElement | null
    expect(peerAvatar).not.toBeNull()
    await clickElement(peerAvatar!)
    expect(document.body.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.messageAvatarProfileMenu}"]`)?.textContent).toContain('100222')
  })
})

async function renderChatArea(chatState: {
  activeChat: ReturnType<typeof chat>
  messages: MessageItem[]
  messagesError?: Error | null
  refreshMessages?: (chatId?: string) => Promise<void>
  activeChatId?: string
  setActiveChatId?: ChatContextValue['setActiveChatId']
  mobile?: boolean
}, devices: Device[] = [testDevice('device-1', [], { is_current_device: true })], contacts?: ContactUser[]) {
  const peerId = chatState.activeChat.peer_user_id
  const identitiesById = Object.fromEntries([
    ['user-1', displayIdentity('user-1', { display_name: 'User' })],
    ...(peerId ? [[peerId, displayIdentity(peerId, { type: chatState.activeChat.kind === 'ai' ? 'agent' : 'human', display_name: chatState.activeChat.name, avatar: chatState.activeChat.avatar ?? null })] as const] : []),
    ...(groupMock.agents as Array<{ id: string; display_name: string; avatar?: string | null; owner_user_id?: string | null }>).map((agent) => [agent.id, displayIdentity(agent.id, { type: 'agent', display_name: agent.display_name, avatar: agent.avatar ?? null, owner_user_id: agent.owner_user_id === undefined ? 'user-1' : agent.owner_user_id })] as const),
  ])
  await renderWithAppProviders(
    harness,
    createElement(
      DevicesContext.Provider,
      { value: devicesStore(devices) },
      createNode(ChatAreaPanel, { mobile: chatState.mobile }),
    ),
    {
      chat: {
        getImRepository: getImRepositoryMock,
        identitiesById,
        activeChatId: 'chat-1',
        ...chatState,
      },
      ...(contacts ? { contacts: { contacts } } : {}),
    },
  )
}

function mineMessage(overrides: Partial<MessageItem>): MessageItem {
  return messageItem({
    id: 'msg-1',
    sender_user_id: 'user-1',
    created_at: '2026-05-09T00:00:09.000Z',
    is_mine: true,
    ...overrides,
  })
}

// #7199 读不出来 ≠ 没聊过:这条线这次没读出来(读库报错)时,消息区说读不到 + 原因 + 重试,❌ 落进首次对话欢迎页。
describe('消息读失败', () => {
  const agentChat = () => chat({ id: 'chat-1', kind: 'dm', name: 'E2E Agent', avatar: null, peer_user_id: 'agent-1' })

  it('一行都没有:占满列表说读不到与重试,原文收在「查看详情」里;欢迎页不出现;点重试按这条线重读', async () => {
    const refreshMessages = vi.fn(async () => {})
    await renderChatArea({ activeChat: agentChat(), messages: [], messagesError: new Error('column messages_view.sent_by_agent does not exist'), refreshMessages })

    const failure = harness.container.querySelector('[data-testid="chat-load-failed"]')
    expect(failure).not.toBeNull()
    expect(failure?.getAttribute('data-inline')).toBeNull()
    expect(failure?.textContent).toContain('聊天记录没读出来')
    expect(failure?.textContent, '原文默认不摆给人看').not.toContain('sent_by_agent')
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="chat-load-details-toggle"]')!)
    expect(harness.container.querySelector('[data-testid="chat-load-details"]')?.textContent).toContain('sent_by_agent')
    expect(harness.container.querySelector('[data-testid="agent-first-conversation-empty"]')).toBeNull()
    await clickElement(harness.container.querySelector<HTMLElement>('[data-testid="chat-load-retry"]')!)
    expect(refreshMessages).toHaveBeenCalledWith('chat-1')
  })

  it('手上已有行(缓存):已读到的照常画,列表上方压一条读不到 + 重试', async () => {
    await renderChatArea({ activeChat: agentChat(), messages: [mineMessage({ id: 'm-1', content: '早' })], messagesError: new Error('network down') })

    const failure = harness.container.querySelector('[data-testid="chat-load-failed"]')
    expect(failure?.getAttribute('data-inline')).toBe('true')
    expect(harness.container.textContent).toContain('早')
  })

  it('zero human messages does not show an agent welcome page', async () => {
    await renderChatArea({ activeChat: agentChat(), messages: [], messagesError: null })
    expect(harness.container.querySelector('[data-testid="chat-load-failed"]')).toBeNull()
    expect(harness.container.querySelector('[data-testid="agent-first-conversation-empty"]')).toBeNull()
  })

})

// @@@1318 群聊去 thread（thread=session 仅私聊）：群聊不渲染 thread 入口，私聊不变。
describe('#1318 群聊去 thread', () => {
  it('群聊不渲染 thread subtab「新建话题」入口', async () => {
    await renderChatArea({
      activeChat: chat({ id: 'chat-1', kind: 'group', name: 'Team' }),
      messages: [mineMessage({})],
    })
    expect(harness.container.querySelector('[aria-label="新建话题"]')).toBeNull()
  })

  it('私聊(agent DM)不渲染 generic thread subtab「新建话题」入口', async () => {
    await renderChatArea({
      activeChat: chat({ id: 'chat-1', kind: 'ai', name: 'Agent' }),
      messages: [mineMessage({})],
    })
    expect(harness.container.querySelector('[aria-label="新建话题"]')).toBeNull()
  })
})

// @@@5856 话题入口在消息 ⋯ 菜单;开出来是**分栏**,不是切走(product spec)。
// 这一条是整条链路唯一的真渲染判据:菜单项 → 建话题 → 右侧分栏出现 → 主时间线仍在。
describe('#5856 从一条消息开话题', () => {
  it('消息 ⋯ 菜单「开话题」开出右侧分栏,来源那条线留在左边', async () => {
    await renderChatArea({
      activeChat: chat({ id: 'chat-1', kind: 'group', name: 'Team' }),
      messages: [mineMessage({ id: 'msg-1' })],
    })

    // 初始:分栏不在;顶栏也没有「新建话题」——话题必须有来源,❌ 不能凭空建。
    expect(harness.container.querySelector('[data-testid="topic-split-pane"]')).toBeNull()
    expect(harness.container.querySelector('[aria-label="新建话题"]')).toBeNull()

    const actionTarget = harness.container.querySelector(
      `[data-testid="${AUTOMATION_TEST_IDS.messageBubbleActionTarget}"]`,
    ) as HTMLElement | null
    expect(actionTarget).not.toBeNull()
    await fireContextMenu(actionTarget!)

    const openTopicItem = Array.from(document.body.querySelectorAll('*')).find(
      (el): el is HTMLElement => el instanceof HTMLElement && el.textContent?.trim() === '开话题',
    )
    expect(openTopicItem).toBeTruthy()
    await clickElement(openTopicItem!)

    // 建立是一步:点完就有一条话题,❌ 没有中间那张表(选成员/选可见性/确认)。
    expect(topicServiceMock.createTopic).toHaveBeenCalledWith(
      expect.objectContaining({ sourceChatId: 'chat-1', sourceMessageId: 'msg-1' }),
    )

    const pane = harness.container.querySelector('[data-testid="topic-split-pane"]')
    expect(pane).not.toBeNull()
    expect(pane?.textContent).toContain('登录超时')

    // 分栏不是切走:来源那条线的主时间线必须还在,继续能看能发。
    expect(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatMessageList}"]`)).not.toBeNull()
    // 老的群 thread 面板不该再出现(同名不同物,两个并存就是产品里有两个「话题」)。
    expect(harness.container.querySelector('[data-testid="group-thread-panel"]')).toBeNull()
  })

  // 链接、通知、App 点名、⌘K 面板都只是把这条对话摆上来(桌面摆成一块,手机聊天页设成当前对话);摆上来的是话题时,
  // 在这里换成源对话 + 话题分栏 —— 只这一处。
  it.each([['in a block', false], ['on the phone chat page', true]])('%s, a topic put up as the chat becomes its source chat with the topic as the split', async (_where, mobile) => {
    const setActiveChatId = vi.fn()
    await renderChatArea({
      activeChat: chat({ id: 'topic-1', kind: 'topic', name: '登录页白屏', source_chat_id: 'chat-1' }),
      activeChatId: 'topic-1',
      setActiveChatId,
      messages: [],
      mobile,
    })
    expect(setActiveChatId).toHaveBeenCalledWith('chat-1')
    expect(drainTopicSplitRequest('chat-1')).toMatchObject({ chatId: 'topic-1', name: '登录页白屏', sourceChatId: 'chat-1' })
  })
})
