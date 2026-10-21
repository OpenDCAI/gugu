// @vitest-environment jsdom
//
// @@@6404 再点一次**正开着的同一条**话题,分栏里的消息不许消失。
// 旧路径:openSplit → closeRightSurfaces → closeSplit 清空 splitMessages,同一批里又把分栏设回同一条,
// splitChatId 没变、拉取 effect 不重跑 ⇒ 分栏开着但一条消息都没有(owner 实测「偶数次点击都是消失的」)。
// closeRightSurfaces 在这里与 ChatAreaPanel 同形:它会调 closeSplit —— 不这样接,本判据是死的。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../support/testHarness'

const getMessages = vi.fn<(chatId: string) => Promise<MessageItem[]>>()
vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: { listTopicsOfChat: () => Promise.resolve([]), createTopic: vi.fn() },
}))
vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getMessages: (chatId: string) => getMessages(chatId),
    markRead: () => Promise.resolve(),
    getOtherMembersReadSeqs: () => Promise.resolve({}),
  },
}))

const { useTopicSurface } = await import('../../../apps/desktop/src/hooks/useTopicSurface')

let surface: ReturnType<typeof useTopicSurface> | null = null
function Probe() {
  surface = useTopicSurface({
    chat: { id: 'chat-A', kind: 'group' },
    userId: 'user-1',
    closeRightSurfaces: () => surface?.closeSplit(),
    subscribeAccountRevision: () => () => {},
    onCreateFailed: () => {},
  })
  return null
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  surface = null
  getMessages.mockReset().mockImplementation((chatId) => Promise.resolve([message({ id: `${chatId}-m1`, chat_id: chatId, seq: 1 })]))
  harness = createReactHarness()
})
afterEach(() => harness.cleanup())

async function open(chatId: string) {
  await act(async () => { surface?.openSplit({ chatId, name: chatId }) })
  await act(async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() })
  return surface?.splitMessages.map((row) => row.id) ?? []
}

describe('@@@6404 同一条话题连点', () => {
  it('第二、三、四次点下去,分栏里还是那条话题的消息', async () => {
    await renderWithAppProviders(harness, createNode(Probe, {}))
    const seen = []
    for (let click = 0; click < 4; click += 1) seen.push(await open('topic-1'))
    expect(seen).toEqual([['topic-1-m1'], ['topic-1-m1'], ['topic-1-m1'], ['topic-1-m1']])
  })

  it('反例:换到另一条话题照常重拉,❌ 不许把上一条的消息挂在新话题下', async () => {
    await renderWithAppProviders(harness, createNode(Probe, {}))
    expect(await open('topic-1')).toEqual(['topic-1-m1'])
    expect(await open('topic-2')).toEqual(['topic-2-m1'])
    expect(getMessages.mock.calls.map(([chatId]) => chatId)).toEqual(['topic-1', 'topic-2'])
  })
})
