// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import type { ChatItem, ChatUnreadLocator } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import { mergeUnreadRows } from '../../../../apps/desktop/src/lib/chatProjection'
import { LocalImCacheError, openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { phoneChatUnread } from '../../../../apps/desktop/src/mobile/chat/phoneChatUnread'
import { advanceReadWatermark } from '../../../../apps/desktop/src/store/chatRealtimeMutations'
import { chat } from '../../../support/testHarness'

const reads = vi.hoisted(() => ({ write: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/readWriter', async (original) => ({
  ...await original<typeof import('../../../../apps/desktop/src/lib/readWriter')>(),
  writeRead: reads.write,
}))

const locator = (unread: number, addressed: number): ChatUnreadLocator => ({
  stream_id: 'main:topic', stream_kind: 'main', thread_root_id: null, message_id: 'first', message_seq: 1,
  unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false,
})
const topic = (unread: number, addressed: number, source = 'project'): ChatItem =>
  chat({ id: `topic-${source}`, kind: 'topic', source_chat_id: source, unread_count: unread, unread_locator: unread ? locator(unread, addressed) : null })
const row = (stream: string, unread: number, addressed?: number) => ({
  chat_id: 'topic', stream_id: stream, stream_kind: stream.startsWith('thread') ? 'thread' : 'main', thread_root_id: null,
  message_id: `m-${stream}`, message_seq: 1, unread_count: unread, cursor_seq: 0, version: 1, is_marked_unread: false,
  ...(addressed === undefined ? {} : { addressed_count: addressed }),
})

describe('addressed_count is a required column of list_unread_locators', () => {
  it('is summed across the streams of one chat', () => {
    expect(mergeUnreadRows([row('main:topic', 4, 1), row('thread:root', 2, 1)]).get('topic')).toMatchObject({ unread_count: 6, addressed_count: 2 })
  })

  it('a row without it is a protocol error, not the full unread count', () => {
    expect(() => mergeUnreadRows([row('main:topic', 4)])).toThrow(/addressed_count/)
  })

  it('a cached chat row written before the column existed invalidates the local cache, so it is rebuilt from a snapshot', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const adapter = await openLocalSyncDb(new IDBFactory())
    const { addressed_count: _dropped, ...stale } = locator(5, 1)
    await adapter.commit([{ type: 'put', store: 'chat', value: { accountId: 'a', id: 'topic-project', order: 0, value: { ...topic(5, 1), unread_locator: stale } } }])
    await expect(adapter.loadAccount('a')).rejects.toBeInstanceOf(LocalImCacheError)
    adapter.close()
    vi.unstubAllGlobals()
  })
})

describe('chatAttention is the one unread formula', () => {
  it('a topic counts only what is addressed to you in the list; its own tab keeps the full count', () => {
    expect(chatAttention(topic(5, 1))).toEqual({ unread: 5, forYou: 1, askingYou: 1 })
  })

  it('a group keeps its full unread in the list and badges only what is addressed to you', () => {
    const group = chat({ id: 'g', kind: 'group', unread_count: 5, unread_locator: { ...locator(5, 1), stream_id: 'main:g' } })
    expect(chatAttention(group)).toEqual({ unread: 5, forYou: 5, askingYou: 1 })
    expect(chatAttention({ ...group, is_muted: true }).askingYou).toBe(0)
  })

  it('the desktop sidebar and the phone fold a topic into its row by the same number', () => {
    const group = chat({ id: 'project', kind: 'group', unread_count: 3 })
    const other = chat({ id: 'other', kind: 'group', unread_count: 0 })
    for (const addressed of [0, 2]) {
      const chats = [group, topic(111, addressed), other, topic(40, addressed, 'other')]
      const phone = phoneChatUnread(chats)
      const desktop = sidebarChatSignals(chats, new Set(['project']))
      expect(desktop.groupUnread.get('project') ?? 0).toBe(phone.get('project'))
      expect(desktop.chatsUnread).toBe(phone.get('other'))
    }
  })
})

describe('a failed mark-read puts the topic locator back', () => {
  it('so the project row does not drop the addressed count until the next refresh', async () => {
    let fail!: (error: Error) => void
    reads.write.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const before = { ...topic(5, 2), last_read_seq: 0, next_message_seq: 6 }
    const patches: Array<Partial<ChatItem>> = []
    advanceReadWatermark([before], before.id, 5, (_id, partial) => { patches.push(partial) })
    expect(reads.write).toHaveBeenCalledWith({ kind: 'main', chatId: before.id, seq: 5 })
    expect(patches.at(-1)).toMatchObject({ unread_count: 0, unread_locator: null })
    fail(new Error('offline'))
    await Promise.resolve(); await Promise.resolve()
    expect(patches.at(-1)).toMatchObject({ unread_count: 5, unread_locator: before.unread_locator })
    quiet.mockRestore()
  })
})
