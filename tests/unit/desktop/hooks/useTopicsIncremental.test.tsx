// @vitest-environment jsdom
// A line's topic list follows its topics, not its messages. Every message publishes one chat_changed for its own chat;
// a topic's change on its source line carries entity_id = the topic. Only the latter reads anything, and only that topic.
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TopicSummary } from '@gugu/core/shared/types/chat'
import type { ImMessageBatch } from '@shared/core/im-messages'
import { createReactHarness, deferred } from '../../../support/testHarness'
import { AuthContext, type AuthUser } from '../../../../apps/desktop/src/store/auth'
import type { AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'

const listTopicsOfChat = vi.hoisted(() => vi.fn<(sourceChatId: string, topicChatId?: string) => Promise<TopicSummary[]>>())
const ingested = vi.hoisted(() => [] as ImMessageBatch[])
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({ topicService: { listTopicsOfChat } }))
vi.mock('../../../../apps/desktop/src/lib/messageIngest', () => ({
  localMessageQueries: () => ({ throughRevision: async () => '41' }),
  ingestMessages: async (_userId: string, batch: ImMessageBatch) => { ingested.push(batch) },
}))
const { useTopicsOfChat } = await import('../../../../apps/desktop/src/hooks/useTopics')

const topic = (chatId: string, at: string | null, over: Partial<TopicSummary> = {}): TopicSummary => ({ chat_id: chatId, name: chatId,
  source_message_id: 'm1', creator_user_id: null, participant_count: 1, message_count: 1, last_message_at: at, is_participant: true, ...over })
const USER = { id: 'user-1', email: 'u1@example.com', nickname: 'U1' } as AuthUser
const auth = { user: USER, loading: false, status: 'authenticated', updateUser: () => {}, logout: async () => ({ success: true }) } as never

let listeners: AccountRevisionListener[]
const subscribe = (event: string, listener: AccountRevisionListener) => {
  expect(event).toBe('chat_changed')
  listeners.push(listener)
  return () => { listeners = listeners.filter((other) => other !== listener) }
}
const changed = async (...keys: { chat_id: string; entity_id?: string }[]) => {
  await act(async () => {
    for (const listener of listeners) await listener(keys.map((payload, index) => ({ revision: String(50 + index), event: 'chat_changed', payload }) as never))
  })
}
let seen: TopicSummary[] = []
let seenError: string | null = null
function Probe() {
  const state = useTopicsOfChat('line', subscribe)
  seen = state.topics
  seenError = state.error
  return null
}
let harness: ReturnType<typeof createReactHarness>
async function open(rows: TopicSummary[]) {
  listTopicsOfChat.mockResolvedValueOnce(rows)
  await harness.render(createElement(AuthContext.Provider, { value: auth }, createElement(Probe)))
  await act(async () => {})
  listTopicsOfChat.mockClear()
  ingested.length = 0
}
beforeEach(() => { harness = createReactHarness(); listeners = []; listTopicsOfChat.mockReset(); ingested.length = 0 })
afterEach(() => harness.cleanup())

describe('useTopicsOfChat follows topic changes, not line messages', () => {
  it('a message on the line itself reads nothing', async () => {
    await open([topic('t1', '2026-11-06T01:00:00Z'), topic('t2', '2026-11-06T00:00:00Z')])
    await changed({ chat_id: 'line' }, { chat_id: 'line' }, { chat_id: 'other', entity_id: 't9' })
    expect(listTopicsOfChat).not.toHaveBeenCalled()
    expect(ingested).toEqual([])
  })

  it('a topic change reads that one topic, records only its access, and keeps the list in activity order', async () => {
    await open([topic('t1', '2026-11-06T01:00:00Z'), topic('t2', '2026-11-06T00:00:00Z')])
    listTopicsOfChat.mockResolvedValueOnce([topic('t2', '2026-11-06T02:00:00Z', { message_count: 2 })])
    await changed({ chat_id: 'line', entity_id: 't2' })
    expect(listTopicsOfChat.mock.calls).toEqual([['line', 't2']])
    expect(ingested.flatMap((batch) => batch.writes)).toEqual([{ type: 'chatAccess',
      access: { chatId: 't2', sourceChatId: 'line', ownMember: true, revision: '41' } }])
    expect(seen.map((row) => [row.chat_id, row.message_count])).toEqual([['t2', 2], ['t1', 1]])

    listTopicsOfChat.mockResolvedValueOnce([topic('t3', null)])
    await changed({ chat_id: 'line', entity_id: 't3' })
    expect(seen.map((row) => row.chat_id)).toEqual(['t2', 't1', 't3'])

    // Archived or no longer visible: the single read comes back empty and the topic leaves the list.
    listTopicsOfChat.mockResolvedValueOnce([])
    await changed({ chat_id: 'line', entity_id: 't1' })
    expect(seen.map((row) => row.chat_id)).toEqual(['t2', 't3'])
  })

  it('a later read of the same topic wins over an earlier one that lands after it', async () => {
    await open([topic('t1', '2026-11-06T01:00:00Z')])
    const early = deferred<TopicSummary[]>(), late = deferred<TopicSummary[]>()
    listTopicsOfChat.mockReturnValueOnce(early.promise).mockReturnValueOnce(late.promise)
    await changed({ chat_id: 'line', entity_id: 't1' })
    await changed({ chat_id: 'line', entity_id: 't1' })
    await act(async () => { late.resolve([topic('t1', '2026-11-06T03:00:00Z', { name: 'new' })]) })
    await act(async () => { early.resolve([topic('t1', '2026-11-06T02:00:00Z', { name: 'old' })]) })
    expect(seen.map((row) => row.name)).toEqual(['new'])
  })

  it('clears a failed topic read when a later revision refresh succeeds', async () => {
    await open([topic('t1', null)])
    listTopicsOfChat.mockRejectedValueOnce(new Error('topic read failed'))
    await changed({ chat_id: 'line', entity_id: 't1' })
    expect(seenError).toBe('topic read failed')
    listTopicsOfChat.mockResolvedValueOnce([topic('t1', null, { name: 'recovered' })])
    await changed({ chat_id: 'line', entity_id: 't1' })
    expect(seen.map(row => row.name)).toEqual(['recovered'])
    expect(seenError).toBeNull()
  })

  it('a topic change while the whole line is still loading reads the line again', async () => {
    const first = deferred<TopicSummary[]>()
    listTopicsOfChat.mockReturnValueOnce(first.promise)
    await harness.render(createElement(AuthContext.Provider, { value: auth }, createElement(Probe)))
    listTopicsOfChat.mockResolvedValueOnce([topic('t1', null), topic('t2', null)])
    await changed({ chat_id: 'line', entity_id: 't2' })
    await act(async () => { first.resolve([topic('t1', null)]) })
    expect(listTopicsOfChat.mock.calls).toEqual([['line', undefined], ['line', undefined]])
    expect(seen.map((row) => row.chat_id)).toEqual(['t1', 't2'])
  })
})
