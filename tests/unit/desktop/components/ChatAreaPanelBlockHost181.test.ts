// @vitest-environment jsdom
// gugu-dev#181 群聊画在会话页一块里(blockHost):块的页签条就是头 —— 这里不画群聊头,头上那排图标画进页签条右端那一格,
// 对话的头像和名字画进页签那一格,人数挂在成员按钮上。不给 blockHost(对话页、手机、网页)时头栏照旧:每条带这个阳性对照。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { chat, createNode, createReactHarness, displayIdentity, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

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

async function renderPanel(blockHost?: { actions: HTMLElement | null; title: HTMLElement | null }) {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', openNonce: 0, blockHost }), {
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: 'group-1',
      activeChat: chat({ id: 'group-1', kind: 'group', name: '设计评审' }),
      identitiesById: { 'user-1': displayIdentity('user-1'), 'user-2': displayIdentity('user-2') },
      messages: [],
    },
  })
}

const header = () => harness.container.querySelector('[data-chat-area-header]')
const membersButtonIn = (root: ParentNode) => root.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.chatHeaderMembersButton}"]`)

describe('ChatAreaPanel hosted in a block (gugu-dev#181)', () => {
  it('without blockHost keeps its own header with the title and the action icons', async () => {
    await renderPanel()
    expect(header(), 'chat page / phone / web: the header row is still there').not.toBeNull()
    expect(header()?.textContent).toContain('设计评审')
    expect(membersButtonIn(header()!)).not.toBeNull()
    expect(harness.container.querySelector('[data-member-count]'), 'the count stays after the title, not on the button').toBeNull()
  })

  it('in a block draws no header; the icons go to the tab strip slot and the name to the tab slot', async () => {
    await renderPanel({ actions, title })
    expect(header(), 'the block tab strip is the header').toBeNull()
    expect(membersButtonIn(actions), 'the action icons are painted into the tab strip').not.toBeNull()
    expect(actions.querySelector('[data-member-count]')?.textContent).toBe('2')
    expect(title.textContent).toContain('设计评审')
  })

  it('in a block whose slots are not mounted yet still draws no header', async () => {
    await renderPanel({ actions: null, title: null })
    expect(header()).toBeNull()
    expect(membersButtonIn(harness.container)).toBeNull()
  })
})
