// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { chatsInReadScope } from '../../../../apps/desktop/src/session/shared/conversation-row-menu'
import { addNativeReplies, seeNativeReplies, unreadNativeMessages } from '@gugu/session-core/session-record/native-read'

const { rpc, nativeVisible } = vi.hoisted(() => ({ rpc: vi.fn(), nativeVisible: vi.fn() }))

vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron' } }))
vi.mock('@/session/renderer/lib/machine-clients', async original => ({ ...await original<object>(), machineClient: () => ({
  api: { invoke: (channel: string, input: unknown) => {
    if (channel !== 'sessionTimeline.sessionVisible') throw new Error(`Unexpected channel: ${channel}`)
    return nativeVisible(input)
  } },
}) }))

vi.mock('../../../../apps/desktop/src/lib/supabase', async () => {
  const actual = await vi.importActual<typeof import('../../../../apps/desktop/src/lib/supabase')>(
    '../../../../apps/desktop/src/lib/supabase',
  )
  return { ...actual, chatDb: { rpc: (...args: unknown[]) => rpc(...args) } }
})

const { markChatsReadAndRefresh } = await import('../../../../apps/desktop/src/lib/chatUnreadLocator')

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

describe('markChatsReadAndRefresh', () => {
  beforeEach(() => { rpc.mockReset(); nativeVisible.mockReset() })

  it('acknowledges captured native replies even when the cloud unread locator list is empty', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    nativeVisible.mockResolvedValue({ unreadKeys: [] })
    const refresh = vi.fn(async () => {})
    await markChatsReadAndRefresh({
      chats: [], refresh,
      nativeReads: [{ deviceId: 'host', conversationId: 'native-only', itemIds: ['reply'] }],
    })
    expect(nativeVisible).toHaveBeenCalledExactlyOnceWith({ conversationId: 'native-only', itemIds: ['reply'] })
    expect(refresh).toHaveBeenCalledExactlyOnceWith({ acceptEmpty: true })
  })

  it('freezes native identities before the cloud read and leaves later replies unread in the host journal', async () => {
    const itemIds = ['first', 'second']
    let journal = addNativeReplies({}, itemIds)
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'list_unread_locators') {
        journal = addNativeReplies(journal, ['later'])
        itemIds.push('later')
        return { data: [unreadRow('dm', 3), unreadRow('dm', 4, 'thread')], error: null }
      }
      return { data: [{ ...readState, stream_id: args?.p_stream_id }], error: null }
    })
    nativeVisible.mockImplementation(async ({ itemIds: visible }: { itemIds: string[] }) => {
      journal = seeNativeReplies(journal, visible)
      return { unreadKeys: unreadNativeMessages(journal) }
    })
    const result = await markChatsReadAndRefresh({ chats: [chat('dm', 6)], refresh: async () => {},
      nativeReads: [{ deviceId: 'host', conversationId: 'session', itemIds, chatId: 'dm' }] })
    expect(result).toEqual({ failedChats: 0 })
    expect(unreadNativeMessages(journal)).toEqual(['later'])
    expect(nativeVisible).toHaveBeenCalledExactlyOnceWith({ conversationId: 'session', itemIds: ['first', 'second'] })
    expect(rpc).toHaveBeenCalledWith('mark_stream_read', expect.objectContaining({ p_stream_id: 'thread:dm:thread', p_seq: 5 }))
  })

  it('splits a large captured journal into the host limit without adding replies between batches', async () => {
    const itemIds = Array.from({ length: 1001 }, (_, i) => `reply-${i}`)
    rpc.mockResolvedValue({ data: [], error: null })
    nativeVisible.mockImplementation(async () => { itemIds.push('later'); return { unreadKeys: ['later'] } })
    await markChatsReadAndRefresh({ chats: [], refresh: async () => {}, nativeReads: [{ deviceId: 'host', conversationId: 'session', itemIds }] })
    expect(nativeVisible.mock.calls.map(([request]) => request.itemIds.length)).toEqual([500, 500, 1])
    expect(nativeVisible.mock.calls.flatMap(([request]) => request.itemIds)).toEqual(itemIds.slice(0, 1001))
  })

  it('counts cloud and native failures of one DM once and still reads other native conversations', async () => {
    rpc.mockImplementation(async (name: string) => name === 'list_unread_locators'
      ? { data: [unreadRow('failed-dm', 2)], error: null }
      : { data: null, error: { message: 'cloud unavailable' } })
    nativeVisible.mockImplementation(async ({ conversationId }: { conversationId: string }) => {
      if (conversationId !== 'success') throw new Error('host unavailable')
      return { unreadKeys: [] }
    })
    const refresh = vi.fn(async () => {})
    const result = await markChatsReadAndRefresh({ chats: [chat('failed-dm', 4)], refresh, nativeReads: [
      { deviceId: 'host', conversationId: 'failed', itemIds: ['one'], chatId: 'failed-dm' },
      { deviceId: 'host', conversationId: 'success', itemIds: ['two'] },
      { deviceId: 'other-host', conversationId: 'failed', itemIds: ['three'] },
    ] })
    expect(result).toMatchObject({ failedChats: 2, error: expect.any(Error) })
    expect(nativeVisible).toHaveBeenCalledWith({ conversationId: 'success', itemIds: ['two'] })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('reports a failed later native batch without replaying the successful batch or clearing the rest', async () => {
    rpc.mockResolvedValue({ data: [], error: null })
    nativeVisible.mockResolvedValueOnce({ unreadKeys: ['remaining'] }).mockRejectedValueOnce(new Error('disconnected'))
    const result = await markChatsReadAndRefresh({ chats: [], refresh: async () => {}, nativeReads: [
      { deviceId: 'host', conversationId: 'session', itemIds: Array.from({ length: 1001 }, (_, i) => String(i)) },
    ] })
    expect(result).toMatchObject({ failedChats: 1 })
    expect(nativeVisible).toHaveBeenCalledTimes(2)
  })

  it('marks every unread stream up to the seq the store had seen, thread streams on the same chat counter', async () => {
    const rows = [
      unreadRow('a', 38),
      unreadRow('a', 40, 'root-1'), // thread reply seq 40 sits on chat a's shared counter (next_message_seq 42)
      unreadRow('b', 10),
      unreadRow('c', 12), // first unread arrived after the store snapshot (next_message_seq 12 ⇒ seen up to 11)
      unreadRow('gone', 3), // not in the store
    ]
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'list_unread_locators') return { data: rows, error: null }
            return { data: [{ ...readState, stream_id: args?.p_stream_id }], error: null }
    })
    const refresh = vi.fn(async () => {})

    const result = await markChatsReadAndRefresh({ chats: [chat('a', 42), chat('b', 15), chat('c', 12)], refresh })

    expect(result).toEqual({ failedChats: 0 })
    const writes = rpc.mock.calls.filter(([name]) => name !== 'list_unread_locators')
    expect(writes).toEqual([
      ['mark_stream_read', { p_chat_id: 'a', p_stream_id: 'main:a', p_seq: 41, p_thread_root_id: null }],
      ['mark_stream_read', { p_chat_id: 'a', p_stream_id: 'thread:a:root-1', p_seq: 41, p_thread_root_id: 'root-1' }],
      ['mark_stream_read', { p_chat_id: 'b', p_stream_id: 'main:b', p_seq: 14, p_thread_root_id: null }],
    ])
    expect(refresh).toHaveBeenCalledWith({ acceptEmpty: true })
  })

  it('keeps the streams that succeeded and reports how many chats failed', async () => {
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'list_unread_locators') return { data: [unreadRow('a', 5), unreadRow('b', 5), unreadRow('b', 6, 'root-2')], error: null }
      if (args?.p_chat_id === 'b') return { data: null, error: { message: 'boom' } }
      return { data: [{ ...readState, stream_id: args?.p_stream_id }], error: null }
    })
    const refresh = vi.fn(async () => {})

    const result = await markChatsReadAndRefresh({ chats: [chat('a', 9), chat('b', 9)], refresh })

    expect(result).toMatchObject({ failedChats: 1, error: expect.any(Error) })
    expect((result.error as Error).message).toBe('boom')
    expect(rpc).toHaveBeenCalledWith('mark_stream_read', { p_chat_id: 'a', p_stream_id: 'main:a', p_seq: 8, p_thread_root_id: null })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('fails loudly when the unread projection cannot be read', async () => {
    rpc.mockResolvedValue({ data: null, error: { message: 'unread read failed' } })
    const refresh = vi.fn(async () => {})

    await expect(markChatsReadAndRefresh({ chats: [chat('a', 9)], refresh })).rejects.toThrow('unread read failed')
    expect(refresh).not.toHaveBeenCalled()
  })

  it('uses the same main/thread writes for only the selected chat and its child topics', async () => {
    const chats = [chat('root', 10), { ...chat('topic', 7), kind: 'topic' as const, source_chat_id: 'root' }, chat('other', 20)]
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'list_unread_locators') return { data: [unreadRow('root', 4), unreadRow('root', 6, 'legacy'), unreadRow('topic', 3), unreadRow('other', 9)], error: null }
            return { data: [{ ...readState, stream_id: args?.p_stream_id }], error: null }
    })
    const refresh = vi.fn(async () => {})
    await markChatsReadAndRefresh({ chats: chatsInReadScope(chats, 'root'), refresh })
    expect(rpc.mock.calls.filter(([name]) => name !== 'list_unread_locators')).toEqual([
      ['mark_stream_read', { p_chat_id: 'root', p_stream_id: 'main:root', p_seq: 9, p_thread_root_id: null }],
      ['mark_stream_read', { p_chat_id: 'root', p_stream_id: 'thread:root:legacy', p_seq: 9, p_thread_root_id: 'legacy' }],
      ['mark_stream_read', { p_chat_id: 'topic', p_stream_id: 'main:topic', p_seq: 6, p_thread_root_id: null }],
    ])
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('captures the click watermark before waiting for the unread projection', async () => {
    const selected = chat('root', 10)
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'list_unread_locators') {
        selected.next_message_seq = 12
        return { data: [unreadRow('root', 4)], error: null }
      }
      return { data: [{ ...readState, stream_id: args?.p_stream_id }], error: null }
    })
    await markChatsReadAndRefresh({ chats: [selected], refresh: async () => {} })
    expect(rpc).toHaveBeenCalledWith('mark_stream_read', { p_chat_id: 'root', p_stream_id: 'main:root', p_seq: 9, p_thread_root_id: null })
  })

  it.each([false, true])('preserves server manual marks only for automatic reads (automatic=%s)', async (automatic) => {
    // Put the thread first: a later manual main row protects every stream of that topic.
    const rows = [unreadRow('a', 4, 'root'), { ...unreadRow('a', 3), is_marked_unread: true }, unreadRow('b', 2)]
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'list_unread_locators') return { data: rows, error: null }
            return { data: [{ ...readState, stream_id: args?.p_stream_id }], error: null }
    })
    nativeVisible.mockResolvedValue({ unreadKeys: [] })
    await markChatsReadAndRefresh({ chats: [chat('a', 10), chat('b', 10)], refresh: async () => {},
      nativeReads: [{ deviceId: 'host', conversationId: 'a', chatId: 'a', itemIds: ['native-a'] }],
      ...(automatic ? { preserveManualUnread: true } : {}) })
    expect(nativeVisible).toHaveBeenCalledTimes(automatic ? 0 : 1)
    expect(rpc.mock.calls.filter(([name]) => name !== 'list_unread_locators')).toEqual(automatic ? [
      ['mark_stream_read', { p_chat_id: 'b', p_stream_id: 'main:b', p_seq: 9, p_thread_root_id: null }],
    ] : [
      ['mark_stream_read', { p_chat_id: 'a', p_stream_id: 'thread:a:root', p_seq: 9, p_thread_root_id: 'root' }],
      ['mark_stream_read', { p_chat_id: 'a', p_stream_id: 'main:a', p_seq: 9, p_thread_root_id: null }],
      ['mark_stream_read', { p_chat_id: 'b', p_stream_id: 'main:b', p_seq: 9, p_thread_root_id: null }],
    ])
  })

  it('rechecks automatic eligibility after awaiting the unread projection', async () => {
    let current = true
    rpc.mockImplementation(async (name: string, args?: Record<string, unknown>) => {
      if (name === 'list_unread_locators') {
        current = false // a manual mark or closed opening superseded this pending automatic read
        return { data: [unreadRow('a', 3)], error: null }
      }
      return { data: [{ ...readState, stream_id: args?.p_stream_id }], error: null }
    })
    await markChatsReadAndRefresh({ chats: [chat('a', 10)], refresh: async () => {}, canMarkRead: () => current })
    expect(rpc.mock.calls.filter(([name]) => name !== 'list_unread_locators')).toEqual([])
  })
})
