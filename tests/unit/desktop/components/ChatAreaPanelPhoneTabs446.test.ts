// @vitest-environment jsdom
// 手机对话页那排页签(OpenDCAI/gugu#446,原型 v7.12):第一枚「群聊」,后面每个话题一枚;点一枚 = 消息区换成它。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

const { getImRepositoryMock, TOPICS } = vi.hoisted(() => ({
  getImRepositoryMock: vi.fn(),
  TOPICS: [
    { chat_id: 't1', name: '把登录页的报错改成中文并补上测试', source_message_id: 'm1', creator_user_id: 'user-1', last_message_at: null, message_count: 3, participant_count: 2, is_participant: true },
    { chat_id: 't2', name: '周报', source_message_id: 'm2', creator_user_id: 'user-1', last_message_at: null, message_count: 1, participant_count: 2, is_participant: true },
  ],
}))

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
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
  harness = createReactHarness()
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
})

afterEach(() => {
  repository.close()
  harness.cleanup()
})

async function render(chatId: string, mobile = true) {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', mobile, hidden: false, openNonce: 0 }), {
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: chatId,
      activeChat: chat({ id: chatId, kind: 'group', name: '登录改版' }),
    },
  })
  await act(async () => { await Promise.resolve() })
}

const q = (selector: string) => harness.container.querySelector<HTMLElement>(selector)
const tab = (id: string) => q(`[data-testid="phone-chat-tab-${id}"]`)

describe('手机对话页头下面那排页签(#446):群聊 + 每个话题一枚', () => {
  it('有话题的群:第一枚「群聊」选中,后面每个话题一枚,长名字只露前一截', async () => {
    await render('g1')
    expect(q('[data-testid="phone-chat-tabs"]')).not.toBeNull()
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
    expect(tab('t1')?.textContent).toBe('把登录页的报错改成…')
    expect(tab('t2')?.textContent).toBe('周报')
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
  })

  it('点话题那一枚:消息区换成它,没有自己的页头;点回「群聊」它就收起', async () => {
    await render('g1')
    await act(async () => { tab('t2')!.click() })
    expect(q('[data-testid="topic-split-pane"]')?.dataset.topicId).toBe('t2')
    expect(q('[data-testid="topic-split-back"]')).toBeNull()
    expect(tab('t2')?.getAttribute('aria-selected')).toBe('true')
    await act(async () => { tab('main')!.click() })
    expect(q('[data-testid="topic-split-pane"]')).toBeNull()
    expect(tab('main')?.getAttribute('aria-selected')).toBe('true')
  })

  it('没有话题的对话不露这一排', async () => {
    await render('g2')
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
  })

  it('电脑上不画这一排(话题在块页签条 / 分栏里)', async () => {
    await render('g1', false)
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
  })
})
