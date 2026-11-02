import { beforeEach, describe, expect, it, vi } from 'vitest'
const { requests, tableError, chatDb } = vi.hoisted(() => {
  const requests: string[] = []
  const tableError = { blocks: false }
  const chatDb = {
    from: (table: string) => {
      requests.push(table)
      return { select: () => ({ in: async () => ({
        data: [],
        error: table === 'message_agent_delivery_blocks' && tableError.blocks
          ? { message: 'refusal table unavailable' } : null,
      }) }) }
    },
  }
  return { requests, tableError, chatDb }
})
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({ chatDb }))
import { writeIdempotentChatMessage } from '../../../apps/desktop/src/lib/chatMessageWriter'

const input = { id: 'message', chatId: 'chat', senderUserId: 'sender', toUserIds: null, content: 'hello', contentType: 'text', replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false }
const messageRow = {
  id: input.id, chat_id: input.chatId, sender_user_id: input.senderUserId,
  content: input.content, content_type: input.contentType, seq: 1,
}
const row = {
  message: messageRow, reactions: [], deliveries: [],
  delivery_blocks: [{ message_id: input.id, agent_user_id: 'archived-agent', reason: 'agent_archived' }],
}

function client(data: unknown = row) {
  return { rpc: vi.fn(async (name: string) => {
    requests.push(name)
    return { data: name === 'send_message_with_overlays' ? data : [messageRow], error: null }
  }) }
}

beforeEach(() => {
  requests.length = 0
  tableError.blocks = false
})

describe('message send confirmation request budget', () => {
  it('s1: confirms the message and its archived-agent refusal in one request', async () => {
    const message = await writeIdempotentChatMessage(input, client())
    expect(requests).toEqual(['send_message_with_overlays'])
    expect(message.delivery_blocks).toEqual([{ agent_user_id: 'archived-agent', reason: 'agent_archived' }])
  })

  it('s2: a failing refusal-table read cannot turn a persisted send into failure', async () => {
    tableError.blocks = true
    await expect(writeIdempotentChatMessage(input, client())).resolves.toMatchObject({ id: input.id })
    expect(requests).toEqual(['send_message_with_overlays'])
  })

  it.each(['reactions', 'deliveries', 'delivery_blocks'])('s3: reports an older database when %s is absent', async (column) => {
    const older: Record<string, unknown> = { ...row }
    delete older[column]
    await expect(writeIdempotentChatMessage(input, client(older))).rejects.toThrow('the database is older than this client')
    expect(requests).toEqual(['send_message_with_overlays'])
  })

  it('folds current reactions, read receipts and refusals returned by an idempotent replay', async () => {
    const message = await writeIdempotentChatMessage(input, client({
      ...row,
      reactions: [
        { message_id: input.id, user_id: 'sender', emoji: 'ok' },
        { message_id: input.id, user_id: 'peer', emoji: 'ok' },
      ],
      deliveries: [
        { message_id: input.id, device_id: 'gugu-agent:sender', status: 'delivered' },
        { message_id: input.id, device_id: 'gugu-agent:sender', status: 'read' },
        { message_id: input.id, device_id: 'gugu-agent:peer', status: 'read' },
      ],
    }))
    expect(message).toMatchObject({
      reactions: [{ emoji: 'ok', count: 2, my_reaction: true }],
      delivered: true, delivery_status: 'read', readers: ['sender', 'peer'],
      delivery_blocks: [{ agent_user_id: 'archived-agent', reason: 'agent_archived' }],
    })
    expect(requests).toEqual(['send_message_with_overlays'])
  })
})

describe('message writer failure causes', () => {
  it('preserves a concrete RPC rejection and its original structured cause', async () => {
    const error = { message: 'Message recipient no longer belongs to the group', code: 'P0001' }
    const rpc = vi.fn(async () => ({ data: null, error }))
    await expect(writeIdempotentChatMessage(input, { rpc })).rejects.toMatchObject({ message: error.message, cause: error })
  })
  it('reports an invalid RPC result without exposing the returned row in its message', async () => {
    const rpc = vi.fn(async () => ({ data: { privatePayload: 'not a message' }, error: null }))
    await expect(writeIdempotentChatMessage(input, { rpc })).rejects.toThrow('send_message_with_overlays returned an unexpected row shape')
  })
})
