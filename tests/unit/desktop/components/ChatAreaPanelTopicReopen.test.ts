// @vitest-environment jsdom
// 2026-09-29 手机实测:从群退回会话列表,再点这个群下面的话题行 → 只进了群,话题页不出来(先点过别的会话再点就正常)。
// 列表点话题 = 切到来源线 + 往盒子里放一条请求。来源线就是当前线时,聊天区(隐藏着)在事件里当场取走、开出分栏;
// 同一次点击把手机会话页露出来并 bump openNonce,重置 effect 在那次提交里 closeRightSurfaces 把刚开的分栏关了。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { requestTopicSplit } from '../../../../apps/desktop/src/lib/topicSplitRequest'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

const { getImRepositoryMock } = vi.hoisted(() => ({ getImRepositoryMock: vi.fn() }))

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
// A closing panel retained for its exit animation must not count as an open panel.
vi.mock('framer-motion', async (importOriginal) => ({
  ...await importOriginal<typeof import('framer-motion')>(),
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))
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
    getChatFiles: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    getGroupCollab: vi.fn(async () => ({
      snapshot: {
        scheduler: { chat_id: 'g1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-29T00:00:00.000Z' },
        humans: [], agents: [], tasks: [], outputs: [],
      },
      identities: [],
    })),
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

async function render(hidden: boolean, openNonce: number) {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { mobile: true, hidden, openNonce }), {
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: 'g1',
      activeChat: chat({ id: 'g1', kind: 'group', name: '产品周会' }),
    },
  })
}

// 手机上话题是对话页那排页签里的一枚(#446):没有自己的页头和返回钮,认它自己那一栏。
const topicPage = () => harness.container.querySelector('[data-testid="topic-split-pane"]')

describe('手机从列表点回同一个群的话题行,话题页要出来', () => {
  it('a repeated sidebar request closes the split and a third request opens it again', async () => {
    await render(false, 0)
    const request = { chatId: 't1', name: 'Topic', sourceChatId: 'g1', focusComposer: true, toggle: true }
    await act(async () => { requestTopicSplit(request) })
    expect(topicPage()).not.toBeNull()
    await act(async () => { requestTopicSplit(request) })
    expect(topicPage()).toBeNull()
    await act(async () => { requestTopicSplit(request) })
    expect(topicPage()).not.toBeNull()
  })

  it('会话页隐藏时放进来的请求,等露出来(openNonce 同时 +1)之后才开,❌ 被重开的重置关掉', async () => {
    await render(true, 0)
    await act(async () => { requestTopicSplit({ chatId: 't1', name: '北京天气', sourceChatId: 'g1', focusComposer: true }) })
    await render(false, 1)
    expect(topicPage()).not.toBeNull()
  })

  it('正对照:会话页本来就露着,请求当场开出话题页', async () => {
    await render(false, 0)
    await act(async () => { requestTopicSplit({ chatId: 't1', name: '北京天气', sourceChatId: 'g1', focusComposer: true }) })
    expect(topicPage()).not.toBeNull()
  })


})
