import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openFixture, type FixtureDb } from '@tooling/utils/db'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ImMessageBatch } from '@shared/core/im-messages'
import { createImMessageStore } from './store'

vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }))

let fixture: FixtureDb
const account = 'account-a'
const message = (id: string, content = 'orchid original', seq = 1, over: Partial<MessageItem> = {}) => {
  const row = {
    ...messageItemFromRow({ id, chat_id: 'chat-a', seq, content, content_type: 'text',
    sender_user_id: account, created_at: '2026-11-02T00:00:00Z', thread_root_id: null }, account)!, ...over,
  }
  delete row.local_send_state
  return row
}
const batch = (...messages: MessageItem[]): ImMessageBatch => ({ writes: messages.map(message => ({ type: 'put', message })), revisions: [] })
const hits = (term: string, owner = account) => fixture.sqlite.prepare(`SELECT m.id FROM im_messages_text
  JOIN im_messages m ON m.rowid = im_messages_text.rowid
  WHERE im_messages_text MATCH ? AND m.account_id = ? ORDER BY m.id`).all(`"${term}"`, owner)
const stored = () => fixture.sqlite.prepare('SELECT rowid, * FROM im_messages ORDER BY account_id, id').all()
const integrity = () => fixture.sqlite.exec("INSERT INTO im_messages_text(im_messages_text) VALUES('integrity-check')")

describe('durable local IM messages', () => {
  beforeEach(async () => { fixture = await openFixture('empty') })
  afterEach(() => { vi.restoreAllMocks(); fixture.close() })

  it('searches stored history outside a display window, using projected short and trigram terms in the requested account and chat', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, batch(message('older', 'orchid 登录', 1),
      message('newer', 'current window', 500), message('elsewhere', 'orchid 登录', 1, { chat_id: 'chat-b' }),
      message('attachment', '[附件] orchid.png (image/png)\n[URL] https://private.invalid/excluded\n[Size] 1\n[Kind] image', 2, { content_type: 'attachment' })))
    store.ingest('account-b', batch(message('private', 'orchid 登录')))
    expect(store.windows(account, ['chat-a'], 1).map(row => row.id)).toEqual(['newer'])
    expect((await store.search(account, 'chat-a', 'orchid 登录', 50)).map(row => row.id)).toEqual(['older'])
    expect((await store.search(account, 'chat-a', '登录', 50)).map(row => row.id)).toEqual(['older'])
    expect((await store.search(account, 'chat-a', 'or', 50)).map(row => row.id)).toEqual(['older', 'attachment'])
    expect((await store.search(account, 'chat-a', 'im', 50))).toEqual([])
    expect((await store.search(account, 'chat-a', 'excluded', 50))).toEqual([])
    expect((await store.search(account, 'chat-a', 'never-stored', 50))).toEqual([])
    // No words (a quick filter on its own): every stored message of the chat, oldest first like any result.
    expect((await store.search(account, 'chat-a', '', 50)).map(row => row.id)).toEqual(['older', 'attachment', 'newer'])
    integrity()
  })

  it('upserts in place, stores the body once, and removes old FTS entries with recursive triggers off', async () => {
    const store = createImMessageStore(fixture.sqlite)
    expect(fixture.sqlite.pragma('recursive_triggers', { simple: true })).toBe(0)
    store.ingest(account, batch(message('one')))
    const first = stored()[0] as { rowid: number; rest: string; content: string }
    expect(first.content).toBe('orchid original')
    expect(Object.hasOwn(JSON.parse(first.rest), 'content')).toBe(false)
    expect(fixture.sqlite.prepare('SELECT text FROM im_messages_text').get()).toEqual({ text: null })
    store.ingest(account, batch(message('one')))
    store.ingest(account, batch(message('one', 'violet revised')))
    expect((stored()[0] as { rowid: number }).rowid).toBe(first.rowid)
    expect(hits('orchid')).toEqual([])
    expect(hits('violet')).toEqual([{ id: 'one' }])
    integrity()
  })

  it('keeps the explicit integer row IDs and FTS mappings stable across VACUUM', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, batch(message('removed'), message('kept', 'violet survivor', 2)))
    store.ingest(account, { writes: [{ type: 'delete', chatId: 'chat-a', id: 'removed' }], revisions: [] })
    const before = stored()
    fixture.sqlite.exec('VACUUM')
    expect(stored()).toEqual(before)
    expect(hits('violet')).toEqual([{ id: 'kept' }])
    integrity()
  })

  it('commits deletion and progress together, rejects late writes, and skips already consumed revision writes', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { ...batch(message('one')), throughRevision: '1' })
    store.ingest(account, { writes: [], revisions: [{ revision: '2', writes: [{ type: 'delete', chatId: 'chat-a', id: 'one' }] }], throughRevision: '2' })
    expect(store.throughRevision(account)).toBe('2')
    expect(stored()).toEqual([])
    expect(hits('orchid')).toEqual([])
    store.ingest(account, batch(message('one', 'late network response')))
    store.ingest(account, { writes: [], revisions: [{ revision: '1', writes: [{ type: 'put', message: message('one') }] }], throughRevision: '1' })
    expect(stored()).toEqual([])
    expect(store.throughRevision(account)).toBe('2')
    integrity()
  })

  it('rolls back original rows, FTS and progress when a page fails', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { ...batch(message('one')), throughRevision: '1' })
    const before = stored()
    expect(() => store.ingest(account, { writes: [], revisions: [
      { revision: '2', writes: [{ type: 'put', message: message('one', 'violet revised') }] },
      { revision: '3', writes: [{ type: 'put', message: { ...message('invalid-sequence'), seq: Number.NaN } }] },
    ], throughRevision: '3' })).toThrow('Invalid message sequence')
    expect(stored()).toEqual(before)
    expect(store.throughRevision(account)).toBe('1')
    expect(hits('orchid')).toEqual([{ id: 'one' }])
    expect(hits('violet')).toEqual([])
    integrity()
  })

  it('ignores optimistic sequences and removes local preview fields from accepted rows', () => {
    const store = createImMessageStore(fixture.sqlite)
    const optimistic = { ...message('optimistic'), seq: -1 }
    expect(store.ingest(account, batch(optimistic))).toEqual([])
    const row = message('confirmed')
    const accepted = store.ingest(account, batch({ ...row, local_send_state: 'sending', image_dimensions: { width: 10, height: 20 } }))
    expect(accepted, 'a page fetch stores the body without claiming it').toEqual([{ type: 'put', message: row }])
    const page = (revision: string, message: MessageItem): ImMessageBatch => ({ writes: [], revisions: [{ revision, writes: [{ type: 'put', message }] }] })
    expect(store.ingest(account, page('1', row)), 'its first revision claims it').toEqual([{ type: 'put', message: row, claimed: true }])
    expect(store.ingest(account, page('2', row)), 'a later revision of a claimed message does not').toEqual([{ type: 'put', message: row }])
    expect(store.ingest(account, batch(row)), 'a later fetch keeps the claim').toEqual([{ type: 'put', message: row }])
    expect(store.ingest(account, page('3', row))).toEqual([{ type: 'put', message: row }])
    expect(stored()).toHaveLength(1)
  })

  it('isolates overlapping message IDs across accounts and clears only an explicitly logged out account', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { ...batch(message('same')), throughRevision: '2' })
    store.ingest('account-b', { ...batch(message('same', 'zinnia private')), throughRevision: '3' })
    expect(hits('zinnia')).toEqual([])
    expect(hits('zinnia', 'account-b')).toEqual([{ id: 'same' }])
    store.clearAccount(account)
    expect(store.throughRevision(account)).toBe(null)
    expect(store.throughRevision('account-b')).toBe('3')
    expect(store.windows(account, ['chat-a'], 40)).toEqual([])
    expect(store.windows('account-b', ['chat-a'], 40)[0]?.content).toBe('zinnia private')
    integrity()
  })

  it('removes an authoritative departed chat and blocks a late page until the chat is authoritatively restored', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, batch(message('one'), message('other', 'violet retained', 1, { chat_id: 'chat-b' })))
    store.ingest(account, { writes: [{ type: 'deleteChat', chatId: 'chat-a' }], revisions: [] })
    store.ingest(account, batch(message('late')))
    expect(store.page(account, { chatId: 'chat-a', limit: 40 }).rows).toEqual([])
    expect(store.page(account, { chatId: 'chat-b', limit: 40 }).rows.map(row => row.id)).toEqual(['other'])
    store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'chat-a', ownMember: true } }, { type: 'put', message: message('new') }], revisions: [] })
    expect(store.page(account, { chatId: 'chat-a', limit: 40 }).rows.map(row => row.id)).toEqual(['new'])
    integrity()
  })

  it('loads only bounded main windows and paginates more than fifty stored thread replies without skipping the root', async () => {
    const store = createImMessageStore(fixture.sqlite)
    const rows = Array.from({ length: 180 }, (_, i) => message(`main-${i + 1}`, 'main', i + 1))
    rows.push(message('root', 'topic root', 181, { is_thread_root: true }))
    rows.push(...Array.from({ length: 130 }, (_, i) => message(`reply-${i + 1}`, 'reply', i + 182, { thread_root_id: 'root' })))
    store.ingest(account, batch(...rows))
    const windows = store.windows(account, ['chat-a'], 40)
    expect(windows).toHaveLength(40)
    expect(windows[0]?.seq).toBe(142)
    expect(windows.at(-1)?.id).toBe('root')
    const all: MessageItem[] = []
    let beforeSeq: number | undefined
    for (;;) {
      const page = store.page(account, { chatId: 'chat-a', threadRootId: 'root', beforeSeq, limit: 50 }).rows
      if (page.length === 0) break
      all.push(...page)
      beforeSeq = page[0]!.seq
    }
    expect(new Set(all.map(row => row.id)).size).toBe(131)
    expect(all.filter(row => row.id === 'root')).toHaveLength(1)
    integrity()
  })

  it('d5: deletes inherited topic histories after a source departure while preserving topics with their own membership', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'source', ownMember: true } },
      { type: 'chatAccess', access: { chatId: 'observer', sourceChatId: 'source', ownMember: false } },
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: true } },
    ], revisions: [] })
    store.ingest(account, batch(...['source', 'observer', 'participant'].map(chat_id => message(chat_id, 'orchid history', 1, { chat_id }))))
    const applied = store.ingest(account, { writes: [], revisions: [
      { revision: '20', writes: [{ type: 'deleteChat', chatId: 'source' }] },
    ], throughRevision: '20' })
    expect(applied).toEqual([{ type: 'deleteChat', chatId: 'source' }, { type: 'deleteChat', chatId: 'observer' }])
    expect(stored()).toHaveLength(1)
    expect(hits('orchid')).toEqual([{ id: 'participant' }])
    expect(store.throughRevision(account)).toBe('20')
    store.ingest(account, batch(message('late-observer', 'late', 2, { chat_id: 'observer' })))
    expect(store.page(account, { chatId: 'observer', limit: 40 }).rows).toEqual([])
    // A relation first learned after the departure must also reject a late page.
    store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'late-topic', sourceChatId: 'source', ownMember: false } },
      { type: 'put', message: message('late-topic-row', 'late', 1, { chat_id: 'late-topic' }) },
    ], revisions: [] })
    expect(store.page(account, { chatId: 'late-topic', limit: 40 }).rows).toEqual([])
    store.ingest(account, { writes: [{ type: 'deleteChat', chatId: 'participant' }], revisions: [] })
    expect(stored()).toEqual([])
    integrity()
  })

  it('uses raw archival facts and rolls back access cleanup with a failing page, without treating unknown memberships as absent', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'chat-a', sourceChatId: null } },
      { type: 'put', message: message('kept') },
    ], revisions: [] })
    expect(() => store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'chat-a', archived: true } },
      { type: 'put', message: { ...message('invalid'), seq: Number.NaN } },
    ], revisions: [], throughRevision: '21' })).toThrow('Invalid message sequence')
    expect(hits('orchid')).toEqual([{ id: 'kept' }])
    expect(store.throughRevision(account)).toBeNull()
    store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'chat-a', archived: true } }], revisions: [] })
    store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'chat-a', ownMember: true } }, { type: 'put', message: message('late') }], revisions: [] })
    expect(stored()).toEqual([])
    expect(hits('orchid')).toEqual([])
    store.clearAccount(account)
    expect(fixture.sqlite.prepare('SELECT * FROM im_message_chats').all()).toEqual([])
    integrity()
  })

  it('ignores a stale topic-list membership after an explicit membership fact or revocation', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: true, membershipRevoked: false, revision: '10' } },
      { type: 'put', message: message('owned-history', 'orchid', 1, { chat_id: 'participant' }) },
    ], revisions: [] })
    // The shared topic-list request began before this member joined, and its response arrives later.
    store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: false, revision: '9' } },
      { type: 'deleteChat', chatId: 'source' },
    ], revisions: [] })
    expect(store.page(account, { chatId: 'participant', limit: 10 }).rows.map(row => row.id)).toEqual(['owned-history'])
    store.ingest(account, { writes: [], revisions: [{ revision: '11', writes: [{ type: 'deleteChat', chatId: 'participant' }] }] })
    // An older positive list response must not reopen a conversation after a newer explicit departure.
    store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: true, revision: '10' } },
      { type: 'put', message: message('late-body', 'late', 2, { chat_id: 'participant' }) },
    ], revisions: [] })
    expect(store.page(account, { chatId: 'participant', limit: 10 }).rows).toEqual([])
    integrity()
  })

  it('d5b: keeps an observer topic on an absent own membership, until its source membership is revoked', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'source', ownMember: true, revision: '5' } },
      { type: 'chatAccess', access: { chatId: 'observer', sourceChatId: 'source', ownMember: false, revision: '5' } },
      { type: 'put', message: message('observer-history', 'orchid', 1, { chat_id: 'observer' }) },
    ], revisions: [] })
    store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'observer', ownMember: false, revision: '6' } }], revisions: [] })
    expect(store.page(account, { chatId: 'observer', limit: 10 }).rows.map(row => row.id)).toEqual(['observer-history'])
    store.ingest(account, { writes: [], revisions: [{ revision: '7', writes: [{ type: 'deleteChat', chatId: 'source' }] }] })
    expect(store.page(account, { chatId: 'observer', limit: 10 }).rows).toEqual([])
    integrity()
  })

  it('compiles each statement once per connection, however many messages and access facts arrive', () => {
    const compiled = new Map<string, number>()
    const prepare = fixture.sqlite.prepare.bind(fixture.sqlite)
    vi.spyOn(fixture.sqlite, 'prepare').mockImplementation(((sql: string) => {
      compiled.set(sql, (compiled.get(sql) ?? 0) + 1)
      return prepare(sql)
    }) as typeof fixture.sqlite.prepare)
    const store = createImMessageStore(fixture.sqlite)
    for (let seq = 1; seq <= 5; seq++) {
      store.ingest(account, { writes: [], revisions: [{ revision: String(seq), writes: [
        { type: 'put', message: message(`m${seq}`, 'orchid', seq) },
        { type: 'chatAccess', access: { chatId: `topic-${seq}`, sourceChatId: 'chat-a', ownMember: seq % 2 === 0 } },
      ] }], throughRevision: String(seq) })
    }
    expect(store.windows(account, ['chat-a'], 10)).toHaveLength(5)
    expect([...compiled].filter(([, times]) => times > 1)).toEqual([])
  })
})
