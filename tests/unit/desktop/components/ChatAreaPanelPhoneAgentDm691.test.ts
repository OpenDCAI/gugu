// @vitest-environment jsdom
// #691 手机和 agent 的私聊:消息区与桌面同一个组件(AgentDmTranscript,任务页的转录),传 mobile;群聊不走它。
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, createElement } from 'react'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'

const { getImRepositoryMock, dmProps } = vi.hoisted(() => ({ getImRepositoryMock: vi.fn(), dmProps: [] as Record<string, unknown>[] }))

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/components/chat/AgentDmTranscript', () => ({
  AgentDmTranscript: (props: Record<string, unknown>) => { dmProps.push(props); return createElement('div', { 'data-testid': 'agent-dm-transcript' }) },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../../apps/desktop/src/lib/chat')>(),
  chatService: {
    getChatFiles: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    markMessageRead: vi.fn(async () => {}),
    getOtherMembersReadSeqs: vi.fn(async () => ({})),
    getThreadMessages: vi.fn(async () => []),
  },
}))

let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository
beforeEach(async () => {
  harness = createReactHarness()
  dmProps.length = 0
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
})
afterEach(() => { repository.close(); harness.cleanup() })

async function render(activeChat: ReturnType<typeof chat>) {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', mobile: true, hidden: false, openNonce: 0 }), {
    chat: { getImRepository: getImRepositoryMock, activeChatId: activeChat.id, activeChat },
  })
  await act(async () => { await Promise.resolve() })
}

it('手机上和 agent 的私聊画任务页那个转录,并告诉它是手机', async () => {
  await render(chat({ id: 'dm1', kind: 'ai', name: 'Claude 9', peer_user_id: 'agent-9' }))
  expect(harness.container.querySelector('[data-testid="agent-dm-transcript"]')).not.toBeNull()
  expect(dmProps.at(-1)).toMatchObject({ agentUserId: 'agent-9', chatId: 'dm1', mobile: true })
})

it('正对照:手机上的群聊照旧是群聊的消息列表', async () => {
  await render(chat({ id: 'g1', kind: 'group', name: '登录改版' }))
  expect(harness.container.querySelector('[data-testid="agent-dm-transcript"]')).toBeNull()
  expect(dmProps).toHaveLength(0)
})
