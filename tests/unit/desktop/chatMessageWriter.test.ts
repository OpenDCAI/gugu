import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {} }))
import { writeIdempotentChatMessage } from '../../../apps/desktop/src/lib/chatMessageWriter'

const input = { id: 'message', chatId: 'chat', senderUserId: 'sender', toUserIds: null, content: 'hello', contentType: 'text', replyToMessageId: null, threadRootId: null, isThreadRoot: false, isWhisper: false }

describe('message writer failure causes', () => {
  it('preserves a concrete RPC rejection and its original structured cause', async () => {
    const error = { message: 'Message recipient no longer belongs to the group', code: 'P0001' }
    const rpc = vi.fn(async () => ({ data: null, error }))
    await expect(writeIdempotentChatMessage(input, { rpc })).rejects.toMatchObject({ message: error.message, cause: error })
  })
  it('reports an invalid RPC result without exposing the returned row in its message', async () => {
    const rpc = vi.fn(async () => ({ data: { privatePayload: 'not a message' }, error: null }))
    await expect(writeIdempotentChatMessage(input, { rpc })).rejects.toThrow('send_message_idempotent returned an unexpected row shape')
  })
})
