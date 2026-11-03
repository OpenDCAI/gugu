// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import type { ChatItem, ChatUnreadLocator } from '@gugu/core/shared/types/chat'
import { chatAttention } from '@gugu/core/shared/ui/chatModels'
import { mergeUnreadRows } from '../../../../apps/desktop/src/lib/chatProjection'
import { LocalImCacheError, openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { sidebarChatSignals } from '../../../../apps/desktop/src/lib/sidebarChatsBridge'
import { phoneChatUnread } from '../../../../apps/desktop/src/mobile/chat/phoneChatUnread'
import { advanceReadWatermark } from '../../../../apps/desktop/src/store/chatRealtimeMutations'
import { acknowledgeOnScreenChatRows } from '../../../../apps/desktop/src/store/chatListProjection'
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

beforeEach(() => { reads.write.mockReset(); reads.write.mockResolvedValue(undefined) })

describe('an open chat does not grow an unread badge', () => {
  it('acknowledges the projected main-stream tail before the row is painted', () => {
    const incoming = chat({ id: 'open-group', kind: 'group', unread_count: 1, last_read_seq: 4, next_message_seq: 6,
      read_state_version: 7, unread_locator: { ...locator(1, 1), stream_id: 'main:open-group', message_seq: 5 } })
    const patches: Array<Partial<ChatItem>> = []
    const pendingReads: Array<() => void> = []

    const [shown] = acknowledgeOnScreenChatRows([incoming], {
      onScreen: (id) => id === incoming.id,
      patchChat: (_id, partial) => { patches.push(partial) },
      deferPersist: (persist) => pendingReads.push(persist),
    })

    expect(shown).toMatchObject({ unread_count: 0, unread_locator: null, last_read_seq: 5, read_state_version: 8 })
    expect(reads.write).not.toHaveBeenCalled()
    pendingReads.forEach((persist) => persist())
    expect(reads.write).toHaveBeenCalledWith({ kind: 'main', chatId: incoming.id, seq: 5 })
    expect(patches).toEqual([])

    const [repeated] = acknowledgeOnScreenChatRows([incoming], {
      current: [shown], onScreen: () => true, patchChat: vi.fn(),
    })
    expect(repeated).toMatchObject({ unread_count: 0, unread_locator: null, last_read_seq: 5, read_state_version: 8 })
    expect(reads.write).toHaveBeenCalledOnce()
  })

  it('keeps unread state for chats off screen, manual unread intent, and another stream', () => {
    const offScreen = chat({ id: 'off-screen', kind: 'group', unread_count: 1, last_read_seq: 0, next_message_seq: 2 })
    const manual = chat({ ...offScreen, id: 'manual', is_marked_unread: true })
    const thread = chat({ ...offScreen, id: 'thread', unread_locator: { ...locator(1, 1), stream_id: 'thread:root', stream_kind: 'thread' } })

    const result = acknowledgeOnScreenChatRows([offScreen, manual, thread], {
      onScreen: (id) => id !== offScreen.id,
      patchChat: vi.fn(),
    })

    expect(result).toEqual([offScreen, manual, thread])
    expect(reads.write).not.toHaveBeenCalled()
  })

  it('keeps the badge while the open chat is showing history instead of following the tail', () => {
    const incoming = chat({ id: 'open-history', kind: 'group', unread_count: 1, last_read_seq: 4, next_message_seq: 6 })
    const result = acknowledgeOnScreenChatRows([incoming], {
      onScreen: () => true, canAcknowledge: () => false, patchChat: vi.fn(),
    })
    expect(result).toEqual([incoming])
    expect(reads.write).not.toHaveBeenCalled()
  })

  it('restores the unread tuple if acknowledging the open chat fails', async () => {
    let fail!: (error: Error) => void
    reads.write.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const incoming = chat({ id: 'open-failure', kind: 'group', unread_count: 2, last_read_seq: 3, next_message_seq: 6,
      read_state_version: 4, unread_locator: { ...locator(2, 1), stream_id: 'main:open-failure', message_seq: 4 } })
    const patches: Array<{ partial: Partial<ChatItem>; expected?: number }> = []
    const pending: Array<() => void> = []
    const [shown] = acknowledgeOnScreenChatRows([incoming], { onScreen: () => true,
      patchChat: (_id, partial, expected) => { patches.push({ partial, expected }) }, deferPersist: (persist) => pending.push(persist) })
    expect(shown.unread_count).toBe(0)
    pending[0]!()
    fail(new Error('offline'))
    await Promise.resolve(); await Promise.resolve()
    expect(patches.at(-1)).toEqual({ partial: expect.objectContaining({ unread_count: 2, unread_locator: incoming.unread_locator }), expected: 5 })
    quiet.mockRestore()
  })
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
