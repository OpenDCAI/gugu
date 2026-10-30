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
  readChatPinSettings: vi.fn(async () => ({ appIds: [], topicIds: [...pinPrefs.ids] })),
  setChatPinPreference: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/chatAppPins', () => ({ watchChatAppPins: () => () => {} }))
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
        humans: [], agents: [], tasks: [], outputs: [],
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

async function render(chatId: string, mobile = true, kind: 'group' | 'dm' = 'group') {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', mobile, hidden: false, openNonce: 0 }), {
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: chatId,
      activeChat: chat({ id: chatId, kind, name: '登录改版' }),
      chats: TOPICS.map((topic) => chat({ id: topic.chat_id, kind: 'topic', source_chat_id: 'g1', name: topic.name })),
    },
  })
  await act(async () => { await Promise.resolve() })
}

const q = (selector: string) => harness.container.querySelector<HTMLElement>(selector)
const tab = (id: string) => q(`[data-testid="phone-chat-tab-${id}"]`)

describe('shared group topic tabs (#446, #837)', () => {
  it('shows Group chat and only pinned topics, truncating long phone labels', async () => {
    await render('g1')
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    expect(q('[data-testid="phone-chat-tabs"]')).not.toBeNull()
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
    expect(tab('t1')?.textContent).toBe('把登录页的报错改成…')
    expect(tab('t2')).toBeNull()
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
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

  it('没有话题的对话不露这一排', async () => {
    await render('g2')
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
  })

  it('opens the existing right split from the same pinned strip on desktop', async () => {
    await render('g1', false)
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    expect(tab('t2')).toBeNull()
    await act(async () => { tab('t1')!.click() })
    expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t1')
    expect(q('[data-testid="topic-split-close"]')).not.toBeNull()
  })

  it('does not select Group when the open topic is not pinned, while retaining a keyboard entry point', async () => {
    await render('g1')
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    await act(async () => { requestTopicSplit({ chatId: 't2', name: '周报', sourceChatId: 'g1' }) })
    await vi.waitFor(() => expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t2'))
    expect(tab('main')?.getAttribute('aria-selected')).toBe('false')
    expect(tab('t1')?.getAttribute('aria-selected')).toBe('false')
    expect(tab('main')?.getAttribute('tabindex')).toBe('0')
    await act(async () => { tab('main')!.click() })
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
  })

  it.each([false, true])('hides the strip without pins even when topics exist (mobile=%s)', async (mobile) => {
    pinPrefs.ids = []
    await render('g1', mobile)
    await vi.waitFor(() => expect(queryClient.getQueryData(['chat-pins', 'user-1', 'g1'])).toEqual({ appIds: [], topicIds: [] }))
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
  })

  it('retains existing mobile non-group topic navigation', async () => {
    await render('g1', true, 'dm')
    await vi.waitFor(() => expect(tab('t2')).not.toBeNull())
    await act(async () => { tab('t2')!.click() })
    expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t2')
  })
})
