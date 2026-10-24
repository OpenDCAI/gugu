// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
const {
  chatKinds,
  messageRows,
  chatDbMock,
  insertMessage,
  rpc,
  hiddenFilter,
} = vi.hoisted(() => {
  const hiddenFilter = vi.fn()
  const messageRows: Record<string, unknown>[] = []
  const chatKinds = new Map<string, 'dm' | 'ai' | 'group'>()
  const insertMessage = vi.fn(async () => ({ error: null }))
  const rpc = vi.fn(async (name: string, args: Record<string, unknown> = {}) => ({
    data: name === 'send_message_idempotent' ? [{
      id: args.p_message_id,
      chat_id: args.p_chat_id,
      sender_user_id: args.p_sender_user_id,
      sender_name: 'Owner',
      seq: 1,
      content: args.p_content,
      content_type: args.p_content_type,
      created_at: '2026-08-09T00:00:00.000Z',
      client_message_id: args.p_message_id,
    }] : [],
    error: null,
  }))
  const chatDbMock = {
    from: vi.fn((table: string) => {
      if (table === 'chats') {
        let chatId = ''
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn((_column: string, value: string) => {
            chatId = value
            return chain
          }),
          maybeSingle: vi.fn(async () => ({
            data: chatKinds.has(chatId) ? { kind: chatKinds.get(chatId) } : null,
            error: null,
          })),
        }
        return chain
      }
      if (table === 'messages') return { insert: insertMessage }
      if (table === 'messages_view') {
        const chain = {
          select: vi.fn(() => chain),
          eq: vi.fn(() => chain),
          is: vi.fn(() => chain),
          not: vi.fn((...args: unknown[]) => { hiddenFilter(...args); return chain }),
          maybeSingle: vi.fn(async () => ({ data: null, error: null })),
          or: vi.fn(() => chain),
          order: vi.fn(() => chain),
          limit: vi.fn(async () => ({ data: messageRows, error: null })),
        }
        return chain
      }
      throw new Error(`Unexpected table ${table}`)
    }),
    rpc,
  }
  return { chatKinds, messageRows, chatDbMock, insertMessage, rpc, hiddenFilter }
})
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: chatDbMock,
  identityDb: {},
  dataClient: {},
  syncSchemaClientSession: vi.fn(),
  getCurrentAuthUserId: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/chatCanonicalStorage', () => ({
  forwardCanonicalMessage: vi.fn(),
  uploadCanonicalGroupAvatar: vi.fn(),
}))
import { chatService } from '../../../../apps/desktop/src/lib/chat'
const THREAD_ROOT_ID = '11111111-1111-4111-8111-111111111111'
const MESSAGE_ID = '22222222-2222-4222-8222-222222222222'
beforeEach(() => {
  chatKinds.clear()
  messageRows.length = 0
  chatKinds.set('dm-chat', 'dm')
  chatKinds.set('ai-chat', 'ai')
  chatKinds.set('group-chat', 'group')
  vi.clearAllMocks()
})
describe('chatService private-chat thread gate', () => {
  it('rejects private thread reads and root marking before their data RPCs', async () => {
    await expect(
      chatService.getThreadMessages('dm-chat', THREAD_ROOT_ID, 'owner-user')
    ).rejects.toThrow(/private chats do not support threads/)
    await expect(chatService.markThreadRoot('ai-chat', THREAD_ROOT_ID)).rejects.toThrow(
      /private chats do not support threads/
    )
    expect(rpc).not.toHaveBeenCalled()
    expect(chatDbMock.from).not.toHaveBeenCalledWith('messages_view')
  })
  // Attachments: sendAttachmentBatch holds the same gate (tests/unit/desktop/components/sendAttachmentBatch.test.ts).
  it('rejects private thread-specific text writes instead of rerouting them', async () => {
    await expect(
      chatService.sendMessage('dm-chat', 'owner-user', 'thread reply', MESSAGE_ID, 'text', {
        threadRootId: THREAD_ROOT_ID,
      })
    ).rejects.toThrow(/private chats do not support threads/)
    expect(insertMessage).not.toHaveBeenCalled()
  })
  it('keeps ordinary private quote replies on the main timeline', async () => {
    await chatService.sendMessage('dm-chat', 'owner-user', 'quoted reply', MESSAGE_ID, 'text', {
      replyToMessageId: THREAD_ROOT_ID,
    })
    expect(rpc).toHaveBeenCalledWith('send_message_idempotent', {
      p_message_id: MESSAGE_ID,
      p_chat_id: 'dm-chat',
      p_sender_user_id: 'owner-user',
      p_to_user_ids: null,
      p_content: 'quoted reply',
      p_content_type: 'text',
      p_reply_to_message_id: THREAD_ROOT_ID,
      p_thread_root_id: null,
      p_is_thread_root: false,
      p_is_whisper: false,
    })
    expect(chatDbMock.from).not.toHaveBeenCalledWith('chats')
  })
})
// @@@5856 thread_summaries 这条聚合随群 thread 面板一起退役(它已经没有任何消费方了),所以这里
// 不再断言它 —— 其余几条(thread 读取 / 标 root / 带 thread_root_id 的写)仍在 substrate 上活着。
describe('chatService group thread compatibility', () => {
  it('keeps thread reads, root marking, and writes on their existing paths', async () => {
    await expect(
      chatService.getThreadMessages('group-chat', THREAD_ROOT_ID, 'owner-user')
    ).resolves.toEqual([])
    await chatService.markThreadRoot('group-chat', THREAD_ROOT_ID)
    await chatService.sendMessage('group-chat', 'owner-user', 'thread reply', MESSAGE_ID, 'text', {
      threadRootId: THREAD_ROOT_ID,
    })
    expect(rpc).toHaveBeenCalledWith('mark_thread_root', {
      p_chat_id: 'group-chat',
      p_root_id: THREAD_ROOT_ID,
    })
    expect(chatDbMock.from).toHaveBeenCalledWith('messages_view')
    expect(rpc).toHaveBeenCalledWith('send_message_idempotent', {
      p_message_id: MESSAGE_ID,
      p_chat_id: 'group-chat',
      p_sender_user_id: 'owner-user',
      p_to_user_ids: null,
      p_content: 'thread reply',
      p_content_type: 'text',
      p_reply_to_message_id: null,
      p_thread_root_id: THREAD_ROOT_ID,
      p_is_thread_root: false,
      p_is_whisper: false,
    })
  })
})
// getThreadMessages interpolates rootId into a PostgREST .or() expression, so the UUID guard
// stays ahead of both the chat-kind lookup and the message query.
describe('chatService.getThreadMessages thread-root guard', () => {
  it.each(['root.eq.x,drop', ''])('rejects invalid thread root id %j before any RPC', async (rootId) => {
    await expect(chatService.getThreadMessages('group-chat', rootId, 'owner-user')).rejects.toThrow(/invalid thread root id/)
    expect(chatDbMock.from).not.toHaveBeenCalled()
  })
})

// Source links must obey the same personal deletion boundary as the message list.
describe('chatService exact-message reference', () => {
  it('keeps a message deleted for the current viewer out of reference reads', async () => {
    await expect(chatService.getMessageById(MESSAGE_ID, 'owner-user')).resolves.toBeNull()
    expect(hiddenFilter).toHaveBeenCalledWith('deleted_for_user_ids', 'cs', JSON.stringify(['owner-user']))
  })
})


describe('mainline message bodies', () => {
  it('returns the mapped page without starting overlay requests', async () => {
    messageRows.push({ id: MESSAGE_ID, chat_id: 'group-chat', sender_user_id: 'owner-user', seq: 1, content: 'body', content_type: 'text', created_at: '2026-10-23T00:00:00Z' })
    const rows = await chatService.getMessages('group-chat', 'owner-user', 'initialLoad')
    expect(rows.map((row) => [row.id, row.content])).toEqual([[MESSAGE_ID, 'body']])
    expect(chatDbMock.from.mock.calls.map(([table]) => table)).toEqual(['messages_view'])
  })
})
