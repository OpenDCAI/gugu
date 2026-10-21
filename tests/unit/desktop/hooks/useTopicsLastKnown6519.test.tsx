// @vitest-environment jsdom
// #6519 切回看过的线:话题锚点卡要和消息同一帧出现。清单每次打开都重拉,在它回来之前先端上一次的 ——
// 否则卡片晚一拍冒出来,把上方的消息往上顶(首帧预览让这一拍被看见)。键带用户 id:换账号不串。
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { createReactHarness } from '../../../support/testHarness'
import { AuthContext, type AuthUser } from '../../../../apps/desktop/src/store/auth'

const pending = vi.hoisted(() => ({ resolvers: [] as Array<(rows: unknown[]) => void> }))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({
  topicService: { listTopicsOfChat: vi.fn(() => new Promise((resolve) => { pending.resolvers.push(resolve) })) },
}))
const { useTopicsOfChat } = await import('../../../../apps/desktop/src/hooks/useTopics')

const topic = (chatId: string) => ({ chat_id: chatId, name: chatId, source_message_id: 'm1', participant_count: 1, message_count: 1, last_message_at: null, is_participant: true }) as unknown as TopicSummary
const firstRenderCounts: Record<string, number[]> = {}
function Probe({ chatId }: { chatId: string }) {
  const { topics } = useTopicsOfChat(chatId)
  const seen = firstRenderCounts[chatId] ?? (firstRenderCounts[chatId] = [])
  seen.push(topics.length)
  return null
}
const auth = (user: AuthUser | null) => ({ user, loading: false, status: user ? 'authenticated' : 'unauthenticated', updateUser: () => {}, logout: async () => ({ success: true }) }) as never
const USER_1 = { id: 'user-1', email: 'u1@example.com', nickname: 'U1' } as AuthUser
const USER_2 = { id: 'user-2', email: 'u2@example.com', nickname: 'U2' } as AuthUser

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); pending.resolvers.length = 0; for (const key of Object.keys(firstRenderCounts)) delete firstRenderCounts[key] })
afterEach(() => harness.cleanup())

async function visit(user: AuthUser | null, chatId: string, resolveWith?: unknown[]) {
  firstRenderCounts[chatId] = []
  await harness.render(createElement(AuthContext.Provider, { value: auth(user) }, createElement(Probe, { chatId })))
  const seenBeforeFetch = firstRenderCounts[chatId]?.[0]
  if (resolveWith) await act(async () => { pending.resolvers.shift()?.(resolveWith) })
  return seenBeforeFetch
}

describe('useTopicsOfChat 切回看过的线', () => {
  it('同一账号切回:重拉回来之前就端出上一次的清单', async () => {
    await visit(USER_1, 'chat-a', [topic('t-a')])
    await visit(USER_1, 'chat-b', [])
    expect(await visit(USER_1, 'chat-a')).toBe(1)
  })

  it('换了账号:不端别人的清单', async () => {
    await visit(USER_1, 'chat-c', [topic('t-c')])
    await visit(USER_1, 'chat-d', [])
    expect(await visit(USER_2, 'chat-c')).toBe(0)
  })

  it('没有登录身份:不缓存(阴性对照,与改动前同形)', async () => {
    await visit(null, 'chat-e', [topic('t-e')])
    await visit(null, 'chat-f', [])
    expect(await visit(null, 'chat-e')).toBe(0)
  })
})
