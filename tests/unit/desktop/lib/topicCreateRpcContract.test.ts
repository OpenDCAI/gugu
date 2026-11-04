import { beforeEach, expect, it, vi } from 'vitest'

const { rpc, from } = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { rpc, from }, getCurrentAuthUserId: async () => 'opener',
}))
vi.mock('../../../../apps/desktop/src/lib/groupAdmin', () => ({
  currentGroupAdmin: () => { throw new Error('Topic creation must not add participants through group administration') },
}))
const { topicService } = await import('../../../../apps/desktop/src/lib/topics')

beforeEach(() => { rpc.mockReset(); from.mockReset() })

it('uses create_topic with the durable topic and source IDs, without a local author roster', async () => {
  const sourceMessageId = 'topic-source'
  rpc.mockResolvedValue({ data: [{ chat_id: 'topic', name: 'Source contract', creator_user_id: 'opener' }], error: null })
  const result = await topicService.createTopic({ sourceChatId: 'source', sourceMessageId, name: ' Source contract ', topicId: 'durable-topic' })
  expect(rpc).toHaveBeenCalledExactlyOnceWith('create_topic', {
    p_topic_id: 'durable-topic', p_source_chat_id: 'source', p_source_message_id: sourceMessageId,
    p_name: 'Source contract', p_member_user_ids: null,
  })
  expect(result).toMatchObject({ chat_id: 'topic', source_chat_id: 'source', source_message_id: sourceMessageId, creator_user_id: 'opener' })
  expect(from).not.toHaveBeenCalled()
})

it('keeps explicitly requested participants separate from automatic author enrollment', async () => {
  rpc.mockResolvedValue({ data: [{ chat_id: 'topic' }], error: null })
  await topicService.createTopic({ sourceChatId: 'source', sourceMessageId: 'message', memberUserIds: ['explicit-peer'] })
  expect(rpc).toHaveBeenCalledExactlyOnceWith('create_topic', {
    p_source_chat_id: 'source', p_source_message_id: 'message', p_name: null, p_member_user_ids: ['explicit-peer'],
  })
  expect(from).not.toHaveBeenCalled()
})

it('preserves backend admission errors instead of manufacturing a topic or repairing memberships', async () => {
  rpc.mockResolvedValue({ data: null, error: { message: 'Not a member of the source chat' } })
  await expect(topicService.createTopic({ sourceChatId: 'source', sourceMessageId: 'message' }))
    .rejects.toThrow('Not a member of the source chat')
  expect(rpc).toHaveBeenCalledTimes(1)
  expect(from).not.toHaveBeenCalled()
})
