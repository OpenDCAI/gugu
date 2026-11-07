// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import type { ChatItem, ChatUnreadLocator, MessageItem } from '@gugu/core/shared/types/chat'
import { chatAttention, mergeFetchedChatsPreservingActiveLocal } from '@gugu/core/shared/ui/chatModels'
import { mergeUnreadRows } from '../../../../apps/desktop/src/lib/chatProjection'
import { unreadAboveCount } from '../../../../apps/desktop/src/lib/chatUnreadLocatorWindow'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
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

describe('unreadAboveCount', () => {
  const locator = (message_seq: number, first_addressed_seq: number | null) => ({ message_seq, first_addressed_seq, unread_count: 43 }) as ChatUnreadLocator
  const rows = (...seqs: number[]) => seqs.map(seq => ({ seq, is_mine: false })) as MessageItem[]
  it('is the opening total when the topic opened at its latest message', () => {
    expect(unreadAboveCount(locator(1, null), rows(1, 2))).toBe(43)
  })
  it('counts only what is above the landing, without your own messages', () => {
    expect(unreadAboveCount(locator(1, 6), [...rows(1, 2, 3, 4, 5, 6, 7), { seq: 4, is_mine: true } as MessageItem])).toBe(5)
  })
  it('says N+ when the window does not reach the first unread', () => {
    expect(unreadAboveCount(locator(1, 90), rows(30, 31, 90))).toBe('2+')
  })
})

describe('addressed_count is a required column of list_unread_locators', () => {
  it('is summed across the streams of one chat', () => {
    expect(mergeUnreadRows([row('main:topic', 4, 1), row('thread:root', 2, 1)]).get('topic')).toMatchObject({ unread_count: 6, addressed_count: 2 })
  })

  it('keeps the earliest addressed message across streams, and no message when the backend names none', () => {
    const addressed = (id: string, seq: number | string) => ({ first_addressed_message_id: id, first_addressed_seq: seq })
    expect(mergeUnreadRows([{ ...row('main:topic', 4, 1), ...addressed('later', 9) }, { ...row('thread:root', 2, 1), ...addressed('earlier', '3') }]).get('topic'))
      .toMatchObject({ first_addressed_message_id: 'earlier', first_addressed_seq: 3 })
    expect(mergeUnreadRows([row('main:topic', 4, 1), { ...row('thread:root', 2, 1), ...addressed('only', 5) }]).get('topic'))
      .toMatchObject({ first_addressed_message_id: 'only', first_addressed_seq: 5 })
    expect(mergeUnreadRows([row('main:topic', 4, 1)]).get('topic')).toMatchObject({ first_addressed_message_id: null, first_addressed_seq: null })
  })

  it('a row without it is a protocol error, not the full unread count', () => {
    expect(() => mergeUnreadRows([row('main:topic', 4)])).toThrow(/addressed_count/)
  })

  it('a cached chat row written before the column existed is dropped alone, and the cursor with it so a snapshot rebuilds it', async () => {
    vi.stubGlobal('IDBKeyRange', IDBKeyRange)
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const adapter = await openLocalSyncDb(new IDBFactory())
    const { addressed_count: _dropped, ...stale } = locator(5, 1)
    await adapter.commit([
      { type: 'put', store: 'chat', value: { accountId: 'a', id: 'topic-project', order: 0, value: { ...topic(5, 1), unread_locator: stale } } },
      { type: 'put', store: 'chat', value: { accountId: 'a', id: 'topic-fresh', order: 1, value: { ...topic(5, 1), id: 'topic-fresh' } } },
      { type: 'put', store: 'sync_state', value: { accountId: 'a', key: 'account-revision-cursor', value: { revision: '7' } } },
    ])
    const rows = await adapter.loadAccount('a')
    expect(rows.chat.map((row) => row.id)).toEqual(['topic-fresh'])
    expect(rows.sync_state).toEqual([])
    adapter.close()
    quiet.mockRestore()
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

describe('open-chat 的确认不会越过可见进度与手工未读', () => {
  it('手工未读原样交给权威合并,确认不碰它', () => {
    const fetched = chat({ id: 'manual-race', kind: 'group', unread_count: 1, last_read_seq: 4, next_message_seq: 6, read_state_version: 7 })
    const manual = { ...fetched, is_marked_unread: true }
    const [kept] = acknowledgeOnScreenChatRows([fetched], {
      current: [manual], onScreen: () => true, patchChat: vi.fn(),
    })
    // 行原样返回:保留手工未读是权威合并(applyFetchedChatList → mergeFetchedChatsPreservingActiveLocal)的职责(评审),
    // 这里合成「已读」的话,版本一抬就把用户更新的手工标未读盖掉了。
    expect(kept).toBe(fetched)
    expect(reads.write).not.toHaveBeenCalled()
  })

  it('await 期间本地读状态变了:延迟的确认作废,不写本地也不发 mark_read', () => {
    const fetched = chat({ id: 'race-manual', kind: 'group', unread_count: 1, last_read_seq: 4, next_message_seq: 6, read_state_version: 7,
      unread_locator: { ...locator(1, 1), stream_id: 'main:race-manual', message_seq: 5 } })
    const live: ChatItem[] = [fetched]
    const pending: Array<() => void> = []
    const patchChat = vi.fn()
    const [acknowledged] = acknowledgeOnScreenChatRows([fetched], {
      current: [fetched], onScreen: () => true, patchChat, liveRows: () => live,
      deferPersist: (persist) => pending.push(persist),
    })
    expect(acknowledged).toMatchObject({ last_read_seq: 5 })

    // applyFetchedChatList 的 await 期间:用户手工标未读,版本抬到与乐观行同一格(评审的竞态)。
    live[0] = { ...acknowledged, is_marked_unread: true }
    pending.forEach((persist) => persist())
    expect(reads.write, '作废的确认不发 mark_read').not.toHaveBeenCalled()
    expect(patchChat, '作废的确认不写本地').not.toHaveBeenCalled()

    // 只是本地读状态往前走了(没有手工位)同样作废。
    reads.write.mockClear()
    live[0] = { ...fetched, last_read_seq: 6, read_state_version: 8 }
    const again: Array<() => void> = []
    acknowledgeOnScreenChatRows([fetched], {
      current: [fetched], onScreen: () => true, patchChat, liveRows: () => live,
      deferPersist: (persist) => again.push(persist),
    })
    again.forEach((persist) => persist())
    expect(reads.write).not.toHaveBeenCalled()
  })

  it('a partial window advances only the visible cursor and awaits authoritative unread counts', () => {
    const fetched = chat({ id: 'tail-pending', kind: 'group', unread_count: 5, last_read_seq: 2, next_message_seq: 8, read_state_version: 7,
      unread_locator: { ...locator(5, 2), stream_id: 'main:tail-pending', message_seq: 3 } })
    const [shown] = acknowledgeOnScreenChatRows([fetched], {
      onScreen: () => true, visibleSeqOf: () => 5, patchChat: vi.fn(),
    })
    expect(shown.last_read_seq).toBe(5)
    // The list row has no per-message unread set; seq 3..5 need not be three unread messages.
    expect(shown.unread_count).toBe(5)
    expect(shown.unread_locator).toEqual(fetched.unread_locator)
    expect(reads.write).toHaveBeenCalledWith({ kind: 'main', chatId: fetched.id, seq: 5 })
  })

  it('sparse seq: leaves unread messages 6 and 7 intact when only seq 5 is visible', () => {
    const fetched = chat({ id: 'sparse-tail', kind: 'group', unread_count: 2, last_read_seq: 2, next_message_seq: 8, read_state_version: 7,
      unread_locator: { ...locator(2, 1), stream_id: 'main:sparse-tail', message_seq: 6 } })
    const [shown] = acknowledgeOnScreenChatRows([fetched], {
      onScreen: () => true, visibleSeqOf: () => 5, patchChat: vi.fn(),
    })
    expect(shown.last_read_seq).toBe(5)
    expect(shown.unread_count).toBe(2)
    expect(shown.unread_locator).toEqual(fetched.unread_locator)
    expect(reads.write).toHaveBeenCalledWith({ kind: 'main', chatId: fetched.id, seq: 5 })
  })

  it('accepts the exact unread tuple from the read revision instead of a seq estimate', () => {
    const fetched = chat({ id: 'authority', kind: 'group', unread_count: 5, last_read_seq: 2, next_message_seq: 8, read_state_version: 7,
      unread_locator: { ...locator(5, 2), stream_id: 'main:authority', message_seq: 3 } })
    const [shown] = acknowledgeOnScreenChatRows([fetched], {
      onScreen: () => true, visibleSeqOf: () => 5, patchChat: vi.fn(),
    })
    const [replayed] = acknowledgeOnScreenChatRows([fetched], {
      current: [shown], onScreen: () => true, visibleSeqOf: () => 5, patchChat: vi.fn(),
    })
    expect(replayed).toEqual(shown)
    expect(reads.write).toHaveBeenCalledOnce()

    const exact = mergeUnreadRows([{ ...row('main:authority', 2, 1), chat_id: fetched.id,
      message_id: 'unread-6', message_seq: 6, cursor_seq: 5, version: 8 }]).get(fetched.id)!
    const authoritative = { ...fetched, last_read_seq: 5, read_state_version: 8, unread_count: exact.unread_count, unread_locator: exact }
    const [merged] = mergeFetchedChatsPreservingActiveLocal([authoritative], [shown], fetched.id)
    expect(merged).toMatchObject({ last_read_seq: 5, unread_count: 2,
      unread_locator: { message_id: 'unread-6', message_seq: 6, unread_count: 2, addressed_count: 1 } })
    const [stillUnread] = acknowledgeOnScreenChatRows([merged], {
      current: [merged], onScreen: () => true, visibleSeqOf: () => 5, patchChat: vi.fn(),
    })
    expect(stillUnread).toEqual(merged)
    expect(reads.write).toHaveBeenCalledOnce()
  })

  it('does not invent a partial unread count when the locator is absent', () => {
    const fetched = chat({ id: 'no-locator', kind: 'group', unread_count: 2, unread_locator: null,
      last_read_seq: 2, next_message_seq: 8, read_state_version: 7 })
    const patches: Array<Partial<ChatItem>> = []
    advanceReadWatermark([fetched], fetched.id, 5, (_id, partial) => { patches.push(partial) })
    expect({ ...fetched, ...patches[0] }).toMatchObject({ last_read_seq: 5, unread_count: 2, unread_locator: null })
    expect(reads.write).toHaveBeenCalledWith({ kind: 'main', chatId: fetched.id, seq: 5 })
  })

  it('restores a partially confirmed cursor and its exact unread tuple after a failed write', async () => {
    let fail!: (error: Error) => void
    reads.write.mockReturnValueOnce(new Promise((_, reject) => { fail = reject }))
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const fetched = chat({ id: 'partial-failure', kind: 'group', unread_count: 2, last_read_seq: 2, next_message_seq: 8,
      read_state_version: 7, unread_locator: { ...locator(2, 1), message_seq: 6 } })
    const patches: Array<{ partial: Partial<ChatItem>; expected?: number }> = []
    const [shown] = acknowledgeOnScreenChatRows([fetched], { onScreen: () => true, visibleSeqOf: () => 5,
      patchChat: (_id, partial, expected) => { patches.push({ partial, expected }) } })
    expect(shown).toMatchObject({ last_read_seq: 5, unread_count: 2, unread_locator: fetched.unread_locator })
    fail(new Error('offline'))
    await Promise.resolve(); await Promise.resolve()
    expect(patches.at(-1)).toEqual({ partial: { unread_count: 2, unread_locator: fetched.unread_locator,
      last_read_seq: 2, is_marked_unread: false, read_state_version: 7 }, expected: 8 })
    quiet.mockRestore()
  })

  it('confirms from the latest complete authoritative tuple when an older projection arrives', () => {
    const fetched = chat({ id: 'newer-tuple', kind: 'group', unread_count: 5, last_read_seq: 2, next_message_seq: 8, read_state_version: 7,
      unread_locator: { ...locator(5, 2), stream_id: 'main:newer-tuple', message_seq: 3 } })
    const current = { ...fetched, unread_count: 2, last_read_seq: 3, read_state_version: 8,
      unread_locator: { ...fetched.unread_locator!, message_seq: 6, unread_count: 2, addressed_count: 1, cursor_seq: 3, version: 8 } }
    const pending: Array<() => void> = []
    const [shown] = acknowledgeOnScreenChatRows([fetched], { current: [current], onScreen: () => true,
      visibleSeqOf: () => 5, patchChat: vi.fn(), liveRows: () => [current], deferPersist: persist => pending.push(persist) })
    const [merged] = mergeFetchedChatsPreservingActiveLocal([shown], [current], fetched.id)
    pending.forEach(persist => persist())
    expect.soft(merged).toMatchObject({ unread_count: 2, last_read_seq: 5, read_state_version: 9, unread_locator: current.unread_locator })
    expect.soft(reads.write).toHaveBeenCalledExactlyOnceWith({ kind: 'main', chatId: fetched.id, seq: 5 })
  })

  it('可见进度没有前进时不凭空推进水位', () => {
    const fetched = chat({ id: 'nothing-visible', kind: 'group', unread_count: 1, last_read_seq: 4, next_message_seq: 6, read_state_version: 7 })
    const [same] = acknowledgeOnScreenChatRows([fetched], { onScreen: () => true, visibleSeqOf: () => 4, patchChat: vi.fn() })
    expect(same).toBe(fetched)
    expect(reads.write).not.toHaveBeenCalled()
  })
})
