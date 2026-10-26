// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../../../../apps/desktop/src/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/supabase')>(
    '../../../../apps/desktop/src/lib/supabase',
  )
  return { ...actual, chatDb: { rpc: (...args: unknown[]) => rpc(...args) } }
})

const { markAllChatsReadAndRefresh } = await import('../../../../apps/desktop/src/lib/chatUnreadLocator')

function chat(id: string, nextMessageSeq: number): ChatItem {
  return {
    id,
    kind: 'group',
    status: 'active',
    name: id,
    created_at: '2026-10-22T00:00:00.000Z',
    last_message_at: null,
    last_message_preview: null,
    unread_count: 1,
    pinned_message_id: null,
    last_read_seq: 0,
    next_message_seq: nextMessageSeq,
  }
}

function unreadRow(chatId: string, messageSeq: number, rootId: string | null = null) {
  return {
    chat_id: chatId,
    stream_id: rootId ? `thread:${chatId}:${rootId}` : `main:${chatId}`,
    stream_kind: rootId ? 'thread' : 'main',
    thread_root_id: rootId,
    message_seq: messageSeq,
  }
}

const readState = { last_read_seq: 0, is_marked_unread: false, version: 1 }

describe('markAllChatsReadAndRefresh', () => {
  beforeEach(() => { rpc.mockReset() })

  it('marks every unread stream up to the seq the store had seen, thread streams on the same chat counter', async () => {
    const rows = [
      unreadRow('a', 38),
      unreadRow('a', 40, 'root-1'), // thread reply seq 40 sits on chat a's shared counter (next_message_seq 42)
      unreadRow('b', 10),
      unreadRow('c', 12), // first unread arrived after the store snapshot (next_message_seq 12 ⇒ seen up to 11)
      unreadRow('gone', 3), // not in the store
    ]
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'list_unread_locators') return { data: rows, error: null }
      if (name === 'mark_stream_read') return { data: [{ ...readState, stream_id: args.p_stream_id }], error: null }
      return { data: [readState], error: null }
    })
    const refresh = vi.fn(async () => {})

    const result = await markAllChatsReadAndRefresh({ chats: [chat('a', 42), chat('b', 15), chat('c', 12)], refresh })

    expect(result).toEqual({ failedChats: 0 })
    const writes = rpc.mock.calls.filter(([name]) => name !== 'list_unread_locators')
    expect(writes).toEqual([
      ['mark_read', { p_chat_id: 'a', p_seq: 41 }],
      ['mark_stream_read', { p_chat_id: 'a', p_stream_id: 'thread:a:root-1', p_seq: 41, p_thread_root_id: 'root-1' }],
      ['mark_read', { p_chat_id: 'b', p_seq: 14 }],
    ])
    expect(refresh).toHaveBeenCalledWith({ acceptEmpty: true })
  })

  it('keeps the streams that succeeded and reports how many chats failed', async () => {
    rpc.mockImplementation(async (name: string, args: Record<string, unknown>) => {
      if (name === 'list_unread_locators') return { data: [unreadRow('a', 5), unreadRow('b', 5), unreadRow('b', 6, 'root-2')], error: null }
      if (args.p_chat_id === 'b') return { data: null, error: { message: 'boom' } }
      return { data: [readState], error: null }
    })
    const refresh = vi.fn(async () => {})

    const result = await markAllChatsReadAndRefresh({ chats: [chat('a', 9), chat('b', 9)], refresh })

    expect(result).toMatchObject({ failedChats: 1, error: expect.any(Error) })
    expect((result.error as Error).message).toBe('boom')
    expect(rpc).toHaveBeenCalledWith('mark_read', { p_chat_id: 'a', p_seq: 8 })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('fails loudly when the unread projection cannot be read', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unread read failed' } })
    const refresh = vi.fn(async () => {})

    await expect(markAllChatsReadAndRefresh({ chats: [chat('a', 9)], refresh })).rejects.toThrow('unread read failed')
    expect(refresh).not.toHaveBeenCalled()
  })
})
