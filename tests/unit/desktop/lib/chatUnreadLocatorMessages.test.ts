// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { chatDbMock, limit } = vi.hoisted(() => {
  const limit = vi.fn(async () => ({
    data: [{
      id: 'friend-request:request-1',
      chat_id: 'chat-1',
      sender_user_id: 'sender-1',
      to_user_ids: ['reader-1'],
      seq: 1,
      content: 'hello',
      content_type: 'text',
      reply_to_message_id: null,
      reply_to_sender_user_id: null,
      reply_to_content: null,
      retracted_at: null,
      created_at: '2026-09-17T00:00:00.000Z',
      forwarded_from_message_id: null,
      thread_root_id: null,
      edited_at: null,
      is_whisper: false,
      is_thread_root: false,
      client_message_id: 'friend-request:request-1',
    }],
    error: null,
  }))
  const chain = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    is: vi.fn(() => chain),
    not: vi.fn(() => chain),
    gt: vi.fn(() => chain),
    lte: vi.fn(() => chain),
    or: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit,
  }
  return { chatDbMock: { from: vi.fn(() => chain) }, limit }
})

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: chatDbMock }))
vi.mock('../../../../apps/desktop/src/lib/chatMessageRevalidation', () => ({
  applyMessageOverlays: vi.fn(async (items: unknown[]) => items),
}))
vi.mock('../../../../apps/desktop/src/lib/chatThreadGate', () => ({
  requireThreadCapableChat: vi.fn(),
}))

import { getUnreadLocatorWindow } from '../../../../apps/desktop/src/lib/chatUnreadLocatorMessages'

describe('unread locator message id boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('accepts a stable text message id used by an idempotent friend-request greeting', async () => {
    const result = await getUnreadLocatorWindow('chat-1', {
      stream_id: 'main:chat-1',
      stream_kind: 'main',
      thread_root_id: null,
      message_id: 'friend-request:request-1',
      message_seq: 1,
      unread_count: 1,
      addressed_count: 0,
      cursor_seq: 0,
      version: 0,
      is_marked_unread: false,
    }, 'reader-1')

    expect(result.anchorRows[0]?.id).toBe('friend-request:request-1')
    // @@@6089 三个查询:锚点页 + forward 页 + stream 尾部 seq(read cursor 的上界)。
    expect(limit).toHaveBeenCalledTimes(3)
    expect(result.tailSeq).toBe(1)
  })
})
