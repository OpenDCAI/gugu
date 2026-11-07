// @vitest-environment jsdom
// 手机对话页那排页签(OpenDCAI/gugu#446,原型 v7.12):第一枚「群聊」,后面每个话题一枚;点一枚 = 消息区换成它。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { queryClient } from '../../../../apps/desktop/src/session/renderer/lib/query-client'
import { requestTopicSplit } from '../../../../apps/desktop/src/lib/topicSplitRequest'
import { pressBack } from '../../../../apps/desktop/src/components/ui/sheetStack'

const { getImRepositoryMock, TOPICS, pinPrefs } = vi.hoisted(() => ({
  getImRepositoryMock: vi.fn(),
  pinPrefs: { ids: ['t1'] },
  TOPICS: [
    { chat_id: 't1', name: '把登录页的报错改成中文并补上测试', source_message_id: 'm1', creator_user_id: 'user-1', last_message_at: null, message_count: 3, participant_count: 2, is_participant: true },
    { chat_id: 't2', name: '周报', source_message_id: 'm2', creator_user_id: 'user-1', last_message_at: null, message_count: 1, participant_count: 2, is_participant: true },
  ],
}))

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/chatPinSettings', () => ({
  readChatPinSettings: vi.fn(async () => ({ topicIds: [...pinPrefs.ids] })),
  setChatPinPreference: vi.fn(),
  watchChatPinSettings: () => () => {},
}))
// A closing panel retained for its exit animation must not count as an open panel.
vi.mock('framer-motion', async (importOriginal) => ({
  ...await importOriginal<typeof import('framer-motion')>(),
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    createTopic: vi.fn(),
    listTopicsOfChat: vi.fn(async (chatId: string) => (chatId === 'g1' ? TOPICS : [])),
    getSourceState: vi.fn(async () => ({ kind: 'gone' as const })),
    getAgentFloodAdjustment: vi.fn(async () => null),
    undoAgentFloodAdjustment: vi.fn(async () => 0),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getChatFiles: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    getGroupCollab: vi.fn(async () => ({
      snapshot: {
        scheduler: { chat_id: 'g1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-29T00:00:00.000Z' },
        humans: [], agents: [], tasks: [],
      },
      identities: [],
    })),
    getOtherMembersReadSeqs: vi.fn(async () => ({})),
    getThreadMessages: vi.fn(async () => []),
    // The chat surface reads the viewer's authority from the server projection (group_info_as).
    getGroupChatSettings: vi.fn(async () => ({ id: 'g1', my_role: 'member', can_manage: false, can_dissolve: false, can_archive_topic: false, allow_member_invite: false })),
  },
}))

let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository

beforeEach(async () => {
  pinPrefs.ids = ['t1']
  queryClient.clear()
  harness = createReactHarness()
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
})

afterEach(() => {
  repository.close()
  harness.cleanup()
  queryClient.clear()
})

let topicRows: Record<string, Partial<ReturnType<typeof chat>>> = {}
async function render(chatId: string, mobile = true, kind: 'group' | 'dm' = 'group') {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', mobile, hidden: false, openNonce: 0 }), {
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: chatId,
      activeChat: chat({ id: chatId, kind, name: '登录改版' }),
      chats: TOPICS.map((topic) => chat({ id: topic.chat_id, kind: 'topic', source_chat_id: 'g1', name: topic.name, ...topicRows[topic.chat_id] })),
    },
  })
  await act(async () => { await Promise.resolve() })
}

const q = (selector: string) => harness.container.querySelector<HTMLElement>(selector)
const tab = (id: string) => q(`[data-testid="phone-chat-tab-${id}"]`)

describe('shared group topic tabs (#446, #837)', () => {
  it('phone: Group chat and every topic are on the strip, and there is no topics button', async () => {
    pinPrefs.ids = []
    await render('g1')
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
    expect(tab('t1')?.textContent).toBe('把登录页的报错改成…')
    expect(tab('t2')).not.toBeNull()
    expect(q('[data-testid="group-menu-topics"]')).toBeNull()
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
  })

  it('phone: a topic calling you shows red @N, comes right after Group chat, and plain unread stays a plain count', async () => {
    pinPrefs.ids = []
    const locator = (unread: number, addressed: number) => ({ stream_id: 'main', stream_kind: 'main' as const, thread_root_id: null, message_id: 'm', message_seq: 1, unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false })
    topicRows = { t1: { unread_count: 9, unread_locator: locator(9, 0) }, t2: { unread_count: 27, unread_locator: locator(27, 2) } }
    try {
      await render('g1')
      await vi.waitFor(() => expect(tab('t2')).not.toBeNull())
      expect(tab('t2')!.querySelector('[data-tab-call]')?.textContent).toBe('@2')
      expect(tab('t2')!.getAttribute('aria-label')).toContain('周报')
      expect(tab('t1')!.querySelector('[data-tab-call]')).toBeNull()
      expect(tab('t1')!.textContent).toContain('9')
      const order = [...document.querySelectorAll<HTMLElement>('[data-testid^="phone-chat-tab-"]')].map((node) => node.dataset.testid)
      expect(order.slice(0, 3)).toEqual(['phone-chat-tab-main', 'phone-chat-tab-t2', 'phone-chat-tab-t1'])
    } finally { topicRows = {} }
  })

  it('点话题那一枚:消息区换成它,没有自己的页头;点回「群聊」它就收起', async () => {
    await render('g1')
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    await act(async () => { tab('t1')!.click() })
    expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t1')
    expect(q('[data-testid="topic-split-back"]')).toBeNull()
    expect(tab('t1')?.getAttribute('aria-selected')).toBe('true')
    await act(async () => { tab('main')!.click() })
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
  })

  it('phone: back closes the open topic and shows the group', async () => {
    await render('g1')
    await vi.waitFor(() => expect(tab('t2')).not.toBeNull())
    await act(async () => { requestTopicSplit({ chatId: 't2', name: '周报', sourceChatId: 'g1' }) })
    await vi.waitFor(() => expect(tab('t2')?.getAttribute('aria-selected')).toBe('true'))
    await act(async () => { pressBack() })
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
  })

  it('没有话题的对话不露这一排', async () => {
    await render('g2')
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
  })

  it('opens the existing right split from the pinned strip on desktop', async () => {
    await render('g1', false)
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    expect(tab('t2')).toBeNull()
    await act(async () => { tab('t1')!.click() })
    expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t1')
    expect(q('[data-testid="topic-split-close"]')).not.toBeNull()
  })

  it('selects the open topic on the phone strip, with Group still reachable', async () => {
    await render('g1')
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    await act(async () => { requestTopicSplit({ chatId: 't2', name: '周报', sourceChatId: 'g1' }) })
    await vi.waitFor(() => expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t2'))
    expect(tab('main')?.getAttribute('aria-selected')).toBe('false')
    expect(tab('t1')?.getAttribute('aria-selected')).toBe('false')
    expect(tab('t2')?.getAttribute('aria-selected')).toBe('true')
    await act(async () => { tab('main')!.click() })
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
  })

  it('desktop: hides the strip without pins even when topics exist', async () => {
    pinPrefs.ids = []
    await render('g1', false)
    await vi.waitFor(() => expect(queryClient.getQueryData(['chat-pins', 'user-1', 'g1'])).toEqual({ topicIds: [] }))
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
  })

  it('retains existing mobile non-group topic navigation', async () => {
    await render('g1', true, 'dm')
    await vi.waitFor(() => expect(tab('t2')).not.toBeNull())
    await act(async () => { tab('t2')!.click() })
    expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t2')
  })
})
