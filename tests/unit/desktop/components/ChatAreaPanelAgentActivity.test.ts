// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { readComposer } from '../../../support/composerEditor'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import type { Device, MessageItem } from '@gugu/core/shared/types/chat'
import type { ContactUser } from '@gugu/core/shared/types/contacts'
import { chat, clickElement, contact, createNode, createReactHarness, device as testDevice, displayIdentity, fireContextMenu, message as messageItem, renderWithAppProviders } from '../../../support/testHarness'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { DevicesContext, type DevicesContextValue } from '../../../../apps/desktop/src/store/devicesContext'
import type { AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { presentationOfDisplayStatus } from '../../../support/agentDisplayStatusTestDouble'
import type { ChatContextValue } from '../../../../apps/desktop/src/store/chatContext'
import { chatDisplayName } from '@gugu/core/shared/ui/chatModels'
import { drainTopicSplitRequest } from '../../../../apps/desktop/src/lib/topicSplitRequest'


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
    markMessageRead: vi.fn(async () => {}),
    getThreadMessages: vi.fn(async () => []),
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
  it('renders DM agent running status in the floating bar above the composer, not in the list', async () => {
    presenceMock.status = 'working'
    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'Deploy Bot',
        avatar: '/assets/agent-avatars/agent-01.svg',
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({})],
    })

    const list = harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatMessageList}"]`)
    const runningBar = harness.container.querySelector('[data-testid="agent-running-status"]')

    expect(list).not.toBeNull()
    expect(runningBar).not.toBeNull()
    // @@@1696 DM = 统一运行 token(名 + 流光状态词)，在浮动条内、NOT 在滚动消息列表。
    expect(list?.contains(runningBar)).toBe(false)
    expect(runningBar?.textContent).toContain('Deploy Bot')
    // kindToStateWord(liveStream.latestKind=null) → 「运行中」(无 tool_call kind 时缺省流光动词)。
    expect(runningBar?.textContent).toContain('运行中')
  })

  // 对话头的名字与对话列表、⌘K 面板、「来自 X」同一个函数(chatDisplayName):私聊写对方,备注优先。
  it('names the chat header the way chatDisplayName names the chat', async () => {
    const dm = chat({ id: 'chat-1', kind: 'dm', name: 'Wei Zhang', peer_user_id: 'peer-1', peer_alias: '阿威' })
    await renderChatArea({ activeChat: dm, messages: [] })
    const header = harness.container.querySelector('[data-chat-area-header]')
    expect(chatDisplayName(dm, 'Wei Zhang')).toBe('阿威')
    expect(header?.textContent).toContain(chatDisplayName(dm, 'Wei Zhang'))
  })

  it('#2951: 远端 Agent 显示设备名，运行条名称取会话/通讯录解析结果', async () => {
    presenceMock.status = 'working'

    await renderChatArea(
      {
        activeChat: chat({
          id: 'chat-1',
          kind: 'ai',
          name: '通讯录科研助手',
          peer_user_id: 'agent-1',
        }),
        messages: [mineMessage({})],
      },
      [
        testDevice('device-windows', [], { label: 'Windows 工作站', is_current_device: true }),
        testDevice('device-1', [], { label: 'Mac Studio', is_current_device: false }),
      ],
    )

    const headerStatus = harness.container.querySelector('[data-agent-status-surface="chat-header"]')
    expect(headerStatus?.textContent?.trim()).toBe('运行中 · Mac Studio · Claude Code')
    const runningName = harness.container.querySelector('[data-testid="agent-running-status"] .rtb-nm')
    expect(runningName?.textContent).toBe('通讯录科研助手')
  })

  // @@@1993 - DM 运行条恒「运行中」的根因:单聊只从 liveStream 派生状态词,无 ACP live 流(agent 在别处跑
  // turn / 本会话未订阅流)时落兜底「运行中」,而群聊本就有 presence recentActions 兜底。修复让单聊也在无
  // live 流时回落 presence 的最近动作 kind —— 与群聊同源、显真实动词。本测无 liveStream mock(=无 live 流),
  // 只喂 presence recentActions=['Read'](新鲜),断言运行条显「查阅中」而非「运行中」。
  it('#1993: DM running status shows the real verb from presence recent actions when no live stream', async () => {
    presenceMock.status = 'working'
    presenceMock.recentActions = ['Read'] // 原始工具名;kindToStateWord('read') → 查阅中
    presenceMock.lastActionAt = new Date().toISOString() // 新鲜 → latestRecentAction 认账(非窗外冻结)

    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'Deploy Bot',
        avatar: '/assets/agent-avatars/agent-01.svg',
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({})],
    })

    const runningBar = harness.container.querySelector('[data-testid="agent-running-status"]')
    expect(runningBar).not.toBeNull()
    expect(runningBar?.textContent).toContain('Deploy Bot')
    // 修复点:回落 presence 的 Read → 查阅中(#1993 前此处恒「运行中」)。
    expect(runningBar?.textContent).toContain('查阅中')
    expect(runningBar?.textContent).not.toContain('运行中')
  })

  // @@@1514 - 'channel' kind 已抹除(collapse 进 group)，故只测 group。
  it.each(['group'] as const)('renders %s agent running status in the floating bar above the composer', async (kind) => {
    // group running status is presence-driven (GroupAgentStatusBar): stand up one running agent.
    groupMock.agents = [{ id: 'agent-1', display_name: 'Deploy Bot', type: 'agent', role: 'member', account_status: 'active', avatar: null, email: null }]
    groupMock.statuses = { 'agent-1': 'working' }

    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind,
        name: 'Ops',
      }),
      messages: [],
    })

    const list = harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatMessageList}"]`)
    // @@@1577 M5 B1 — 群聊运行态条 testid 改名 group-agent-running-status(与单聊 agent-running-status 区分,原重名)。
    const runningBar = harness.container.querySelector('[data-testid="group-agent-running-status"]')

    expect(runningBar).not.toBeNull()
    // floats above the composer, not inside the list.
    expect(list?.contains(runningBar)).toBe(false)
    // @@@1696 群聊 token = 名 + 流光状态词；无 recentActivity kind → kindToStateWord(null)=「运行中」。
    expect(runningBar?.textContent).toContain('Deploy Bot')
    expect(runningBar?.textContent).toContain('运行中')
  })

  it('prioritizes my agents in the mobile scroller and keeps every mention target (#6008)', async () => {
    groupMock.agents = ['other-1', 'other-2', 'mine-1', 'mine-2', 'mine-3', 'mine-4', 'mine-idle'].map((id) => ({
      id, display_name: id, type: 'agent', role: 'member', account_status: 'active', avatar: null, email: null,
      owner_user_id: id.startsWith('mine-') ? 'user-1' : 'user-2',
    }))
    groupMock.statuses = {
      'other-1': 'working', 'other-2': 'working', 'mine-1': 'working', 'mine-2': 'working',
      'mine-3': 'working', 'mine-4': 'working', 'mine-idle': 'idle',
    }
    await renderChatArea({ activeChat: chat({ id: 'chat-1', kind: 'group', name: 'Team' }), messages: [] })

    const runningBar = harness.container.querySelector('[data-testid="group-agent-running-status"]')!
    expect(Array.from(runningBar.querySelectorAll('.rtb-nm'), (node) => node.textContent)).toEqual(['mine-1', 'mine-2', 'mine-3', 'mine-4', 'other-1', 'other-2'])
    expect(runningBar.querySelector('.rtb-more')).toBeNull()
    await clickElement(runningBar.querySelector<HTMLButtonElement>('[data-message-preview-trigger="mine-4"]')!)
    expect(readComposer(harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`))).toContain('@mine-4')
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

  it('权威说不在线,标题栏就说不在线(❌ 没有本地态可以盖住它)', async () => {
    presenceMock.status = 'offline'

    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'Deploy Bot',
        avatar: '/assets/agent-avatars/agent-01.svg',
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({})],
    })

    const headerStatus = harness.container.querySelector('[data-agent-status-surface="chat-header"]')
    expect(headerStatus).not.toBeNull()
    // @@@2166① offline 文案 owner 拍板「待命」→「不在线」(「待命会让人以为它还在运行」)。
    expect(headerStatus?.textContent?.trim()).toBe('不在线 · 本机 · Claude Code')
  })

  // 会话正在起对用户就是 working(spec agent-status):不再有「激活中」禁用,消息照常收下。
  it('keeps the agent composer usable while the agent is working (a starting session reads as working)', async () => {
    presenceMock.status = 'working'

    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'Deploy Bot',
        avatar: '/assets/agent-avatars/agent-01.svg',
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({})],
    })

    const headerStatus = harness.container.querySelector('[data-agent-status-surface="chat-header"]')
    expect(headerStatus?.textContent?.trim()).toBe('运行中 · 本机 · Claude Code')

    const composer = harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`) as HTMLElement | null
    expect(composer).not.toBeNull()
    expect(composer?.getAttribute('aria-disabled')).toBe('false')
  })

  it('#1099: keeps the agent composer usable when offline — no wake gate, no wake button, no host-stale ⚠ in header (ACP)', async () => {
    presenceMock.status = 'offline'

    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'Deploy Bot',
        avatar: '/assets/agent-avatars/agent-01.svg',
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({})],
    })

    const composer = harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatComposer}"]`) as HTMLElement | null
    expect(composer).not.toBeNull()
    // 最关键: ACP 下设备在线即可触达,offline 绝不挡发送 —— 输入框始终可用、发消息自动启动 agent。
    expect(composer?.getAttribute('aria-disabled')).toBe('false')
    // 无「唤醒」动作(头栏按钮 + 输入区状态栏按钮均删)、无「Agent 离线…唤醒后再发送」门控提示。
    expect(harness.container.textContent).not.toContain('唤醒')
    expect(harness.container.textContent).not.toContain('Agent 离线，唤醒后再发送消息')
    // 触点2: 头栏不再渲 terminal 时代「host 陈旧」黄色 ⚠ 警告角标。
    expect(harness.container.querySelector('[data-agent-host-stale]')).toBeNull()
  })

  it('#6357: 私聊头部状态只表态、不再弹最近动作卡(近况统一走 working 栏的 MessagePreview)', async () => {
    presenceMock.status = 'working'
    presenceMock.recentActions = ['Bash', 'Bash', 'Read']
    presenceMock.lastActionAt = new Date().toISOString()

    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'Deploy Bot',
        avatar: '/assets/agent-avatars/agent-01.svg',
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({})],
    })

    const headerStatus = harness.container.querySelector('[data-agent-status-surface="chat-header"]')
    expect(headerStatus).not.toBeNull()
    // 正对照:状态本身还在(颜色点 + 文案),只是不再是可弹窗的按钮。
    expect(headerStatus?.textContent?.trim().length).toBeGreaterThan(0)
    expect(headerStatus?.tagName).toBe('SPAN')
    await fireContextMenu(headerStatus as HTMLElement)
    expect(document.body.querySelector('[data-testid="agent-recent-action-popover"]')).toBeNull()
    // 原始工具名不再出现在任何悬浮层里。
    expect(document.body.textContent).not.toContain('Bash')
  })

  it('reloads group collab when the same chat is reopened on mobile (openNonce bump) (#461)', async () => {
    const groupChat = chat({ id: 'chat-1', kind: 'group', name: 'Ops' })
    vi.mocked(chatService.getGroupCollab).mockClear()

    await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', openNonce: 0 }), {
      chat: { getImRepository: getImRepositoryMock, activeChatId: 'chat-1', activeChat: groupChat, messages: [] },
    })
    const before = vi.mocked(chatService.getGroupCollab).mock.calls.length
    expect(before).toBeGreaterThanOrEqual(1)

    // Reopening the SAME chat on mobile bumps openNonce without changing activeChatId — the reset clears the
    // collab snapshot, so the load effect must refire to refill it (the #461 asymmetry this guards).
    await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', openNonce: 1 }), {
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

      await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', openNonce: 0 }), {
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
      createNode(ChatAreaPanel, { activeTab: 'chats' }),
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
      createNode(ChatAreaPanel, { activeTab: 'chats', mobile: chatState.mobile }),
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
  const agentChat = () => chat({ id: 'chat-1', kind: 'ai', name: 'E2E Agent', avatar: null, peer_user_id: 'agent-1' })

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

  it('阴控:没有读失败、零消息 = 首次对话欢迎页,不出读失败;点建议句按这条线预填输入框', async () => {
    await renderChatArea({ activeChat: agentChat(), messages: [], messagesError: null })

    expect(harness.container.querySelector('[data-testid="chat-load-failed"]')).toBeNull()
    const empty = harness.container.querySelector('[data-testid="agent-first-conversation-empty"]')
    expect(empty).not.toBeNull()
    const pick = [...empty!.querySelectorAll<HTMLElement>('button')].find((b) => b.textContent === '介绍一下你自己')
    await clickElement(pick!)
    expect(readComposer(harness.container.querySelector('[data-testid="chat-composer"]'))).toBe('介绍一下你自己')
  })
})

// @@@agent-chat-hero 与 agent 的单聊:头像居中放一只在消息列表正上方(AgentChatHero),
// 空态与每条消息旁边都不再各画一遍。agent 没上传头像 → 咕咕小鸟(canvas),上传了 → 那张图。
describe('agent DM 居中头像', () => {
  it('零消息空态:只有一只居中头像(小鸟),空态里不再重复画头像', async () => {
    // 真零消息空态：无进行中活动(否则 activity 行使 chatListRows 非空、空态不渲染)。
    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'E2E Agent',
        avatar: null,
        peer_user_id: 'agent-1',
      }),
      messages: [],
    })

    const hero = harness.container.querySelector('[data-testid="agent-chat-hero"]')
    expect(hero).not.toBeNull()
    expect(hero?.querySelector('svg[data-agent-avatar-boring]')).not.toBeNull()
    const empty = harness.container.querySelector('[data-testid="agent-first-conversation-empty"]')
    expect(empty).not.toBeNull()
    expect(empty?.querySelector('canvas, img')).toBeNull()
    expect(harness.container.querySelectorAll('svg[data-agent-avatar-boring]').length).toBe(1)
  })

  // #7199 owner 10-17:Agent 没有休息这回事。自己的 agent 住的云端宿主闲时收回着(管家说 asleep)时读数是不在线,
  // 但消息照收、宿主有事自己醒 ⇒ 头像 ❌ 蜷成睡团,画本体;收回着的信号没有(真断了 / 叫醒被拒)就照读数画。
  it.each([
    ['宿主闲时收回着:不画状态,头像是本体', 'asleep' as const, null],
    ['阴控:没有收回着的信号 = 真不在线,照画', undefined, 'offline'],
  ])('%s', async (_name, cloud, state) => {
    presenceMock.status = 'offline'
    const host = testDevice('cloud-1', [], { is_online: false, ...(cloud ? { cloud_computer: cloud } : {}) })
    await renderChatArea(
      { activeChat: chat({ id: 'chat-1', kind: 'ai', name: 'E2E Agent', avatar: null, peer_user_id: 'agent-1' }), messages: [] },
      [testDevice('device-1', [], { is_current_device: true }), host],
      [contact({ id: 'agent-1', type: 'agent', device_id: 'cloud-1' })],
    )

    const face = harness.container.querySelector('[data-testid="agent-chat-hero"] [data-agent]')
    expect(face).not.toBeNull()
    expect(face?.querySelector('.av-status--offline') !== null).toBe(state === 'offline')
  })

  it('头栏就是头像 + 名字 + 状态:没有实线、没有左对齐标题,消息在列表顶边渐隐', async () => {
    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'E2E Agent',
        avatar: null,
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({ id: 'm-1', content: '早' })],
    })

    const header = harness.container.querySelector('[data-chat-area-header]')
    expect(header).not.toBeNull()
    expect(header?.hasAttribute('data-divider'), '头栏不画实线').toBe(false)
    expect(header?.classList.contains('gg-agent-header')).toBe(true)
    expect(header?.querySelector('h2'), '没有左对齐的标题').toBeNull()
    expect(header?.querySelector('[data-testid="agent-chat-hero"]')?.textContent ?? '', '名字在头栏中间的头像块里').toContain('E2E Agent')
  })

  it('头栏不显示「状态 · 位置 · 引擎」那行字:读屏仍读得到,名字悬停给出同一句', async () => {
    presenceMock.status = 'offline'

    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'E2E Agent',
        avatar: null,
        peer_user_id: 'agent-1',
      }),
      messages: [mineMessage({ id: 'm-1', content: '早' })],
    })

    const hero = harness.container.querySelector('[data-testid="agent-chat-hero"]')
    const surface = hero?.querySelector('[data-agent-status-surface="chat-header"]')
    expect(surface, '状态句仍在头栏里(读屏 / 测试面)').not.toBeNull()
    expect(surface?.closest('.sr-only'), '但视觉上不显示').not.toBeNull()
    const sentence = surface?.textContent?.trim() ?? ''
    expect(sentence).toContain('不在线')
    expect(hero?.querySelector('.gg-agent-hero-name')?.getAttribute('title')).toBe(sentence)
    expect(hero?.querySelector('.gg-agent-hero-status'), '没有第二行状态字').toBeNull()
  })

  it('有消息:消息旁不画头像列,整页仍只有那一只', async () => {
    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'E2E Agent',
        avatar: null,
        peer_user_id: 'agent-1',
      }),
      messages: [
        mineMessage({ id: 'm-1', content: '早' }),
        messageItem({ id: 'm-2', sender_user_id: 'agent-1', is_mine: false, content: '早上好', created_at: '2026-05-09T00:00:10.000Z' }),
      ],
    })

    expect(harness.container.querySelectorAll('[data-testid="agent-chat-hero"]').length).toBe(1)
    expect(harness.container.querySelectorAll('svg[data-agent-avatar-boring]').length).toBe(1)
  })

  it('agent 上传过头像:居中的就是那张图(不画小鸟)', async () => {
    await renderChatArea({
      activeChat: chat({
        id: 'chat-1',
        kind: 'ai',
        name: 'E2E Agent',
        avatar: 'https://db.example/storage/v1/object/public/avatars/agent-1.png',
        peer_user_id: 'agent-1',
      }),
      messages: [],
    })

    const hero = harness.container.querySelector('[data-testid="agent-chat-hero"]')
    expect(hero?.querySelector('img')?.getAttribute('src')).toBe('https://db.example/storage/v1/object/public/avatars/agent-1.png')
    expect(hero?.querySelector('svg[data-agent-avatar-boring]')).toBeNull()
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
