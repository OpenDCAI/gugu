import { openFixture } from '@tooling/utils/db'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import { applyMigrations, bundledMigrations, initializeDatabase } from '../../initialize'
import { createImMessageStore } from '../../../core/im-messages/store'
import { createMemoryLocalSyncDb } from '../../../../../../src/lib/localSyncDb'
import { ackOutboxRecord, openImRepository, putOutboxRecord } from '../../../../../../src/lib/imRepository'
import { initializeMessages, ingestMessages, readMessageWindowFromStore } from '../../../../../../src/lib/messageIngest'
import { clearMessageWindows, isMessageWindowHeld, messageWindow, releaseMessageWindows } from '../../../../../../src/lib/messageWindows'
import { createAccountRevisionRuntime } from '../../../../../../src/lib/accountRevisionRuntime'
import { createAccountRevisionCoordinator } from '../../../../../../src/lib/accountRevisionCoordinator'
import { alignMessageStore } from '../../../../../../src/lib/messageStoreRecovery'
import { chatService } from '../../../../../../src/lib/chat'
import { fetchChatHistoryPage, restoreChatHistoryAnchor } from '../../../../../../src/store/chatWindowPublication'
import type { ChatHistoryWindow } from '../../../../../../src/store/chatHistoryWindow'
import { loadMessageOverlays } from '../../../../../../src/lib/chatMessageRevalidation'

const network = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], reactions: [] as Record<string, unknown>[], from: vi.fn() }))
vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }))
vi.mock('../../../../../../src/platform', () => ({ platform: { localMessages: 'sqlite' } }))
vi.mock('../../../../../../src/lib/supabase', () => ({
  chatDb: { from: network.from }, identityDb: {}, dataClient: {}, syncSchemaClientSession: vi.fn(), getCurrentAuthUserId: vi.fn(),
}))
vi.mock('../../../../../../src/lib/chatCanonicalStorage', () => ({ forwardCanonicalMessage: vi.fn(), uploadCanonicalGroupAvatar: vi.fn() }))

const previousUnpublishedWhen = 1793624400000
const skippedWhen = 1793536200000
const all = bundledMigrations()
const migration = all.find(entry => entry.tag.endsWith('_persistent_im_messages'))!

let fixture: Awaited<ReturnType<typeof openFixture>> | undefined
afterEach(() => { fixture?.close(); fixture = undefined; vi.unstubAllGlobals(); clearMessageWindows('account'); vi.restoreAllMocks() })

const message = (seq: number, chat = 'chat') => {
  const value = messageItemFromRow({ id: `${chat}-${seq}`, chat_id: chat, seq, sender_user_id: 'account',
    content_type: 'text', content: `orchid ${seq}`, created_at: '2026-11-03T00:00:00Z' }, 'account')!
  delete value.local_send_state
  return value
}

/** Route the renderer's imMessages IPC straight into a real store on the fixture connection. */
function installStore(store: ReturnType<typeof createImMessageStore>) {
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    const method = channel.replace('imMessages.', '') as keyof typeof store
    if (!channel.startsWith('imMessages.')) throw new Error(`Unexpected IPC ${channel}`)
    return (store[method] as (...args: unknown[]) => unknown)(...args)
  })
  vi.stubGlobal('window', { electronAPI: { invoke, eventOn: () => () => {} }, localStorage: { getItem: () => null } })
  return invoke
}

async function openStore() {
  fixture = await openFixture('empty')
  return createImMessageStore(fixture.sqlite)
}

describe('0046 migration', () => {
  let connection: Database.Database | undefined
  afterEach(() => { connection?.close(); connection = undefined })

  it('follows the published migration sequence and the previous unpublished timestamp', () => {
    expect(migration).toBeDefined()
    expect(migration.tag).toBe('0046_persistent_im_messages')
    const others = all.filter(entry => entry !== migration)
    expect(migration.when).toBeGreaterThan(Math.max(previousUnpublishedWhen, ...others.map(entry => entry.when)))
  })

  it('rejects an obsolete message schema instead of silently skipping its replacement', () => {
    connection = new Database(':memory:')
    // Preserve the previous unpublished shape and migration timestamp. There is deliberately no
    // compatibility migration for this schema: a profile using it must fail before serving data.
    applyMigrations(connection, [{
      tag: '0045_previous_message_schema',
      when: previousUnpublishedWhen,
      sql: `CREATE TABLE im_messages (account_id text NOT NULL, id text NOT NULL, item text NOT NULL);
--> statement-breakpoint
INSERT INTO im_messages VALUES ('account', 'retained', '{"content":"retained body"}');`,
    }])
    const rows = connection.prepare('SELECT * FROM im_messages').all()
    const journal = connection.prepare('SELECT * FROM __drizzle_migrations').all()

    // Negative control through the production runner: a timestamp below the recorded one does
    // nothing, even though the obsolete table has an incompatible shape.
    expect(() => applyMigrations(connection!, [{ ...migration, when: skippedWhen }])).not.toThrow()
    expect(connection.prepare('SELECT * FROM im_messages').all()).toEqual(rows)
    expect(connection.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(journal)

    expect(() => applyMigrations(connection!, [migration])).toThrow(/im_messages.*already exists/i)
    expect(connection.prepare('SELECT * FROM im_messages').all()).toEqual(rows)
    expect(connection.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(journal)
  })

  it('upgrades the preceding schema once with empty tables, then keeps bodies across disposable search rebuilds', async () => {
    fixture = await openFixture('empty', { through: all[all.indexOf(migration) - 1]!.tag })
    const sql = fixture.sqlite
    sql.prepare('INSERT INTO kv(key,value) VALUES (?,?)').run('existing-session-state', 'kept')
    applyMigrations(sql, [migration])
    const journal = sql.prepare('SELECT * FROM __drizzle_migrations').all()
    applyMigrations(sql, [migration])
    expect(sql.prepare('SELECT * FROM __drizzle_migrations').all()).toEqual(journal)
    expect(sql.pragma('table_info(im_messages)')).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'rest' }), expect.objectContaining({ name: 'seq' }),
    ]))
    for (const table of ['im_messages', 'im_message_accounts', 'im_message_chats', 'im_message_tombstones']) {
      expect(sql.prepare(`SELECT * FROM ${table}`).all()).toEqual([])
    }
    const retained = { ...message(1), id: 'old', content: 'orchid retained', created_at: '2026-11-02T00:00:00Z' }
    const store = createImMessageStore(sql)
    store.ingest('account', { writes: [{ type: 'put', message: retained }], revisions: [], throughRevision: '12' })
    sql.prepare('INSERT INTO kv(key,value) VALUES(?,?)').run('fts_version', 'obsolete')
    await initializeDatabase(sql)
    applyMigrations(sql, [migration])
    expect(store.page('account', { chatId: 'chat', limit: 10 }).rows).toEqual([retained])
    expect(store.throughRevision('account')).toBe('12')
    expect(await store.search('account', 'chat', 'orchid', 10)).toEqual([retained])
    expect(sql.prepare('SELECT value FROM kv WHERE key=?').get('existing-session-state')).toEqual({ value: 'kept' })
    expect(sql.pragma('foreign_key_check')).toEqual([])
  })
})

describe('0046 store', () => {
  it('stores query columns once, preserves optional fields, and never stores local previews', async () => {
    const store = await openStore()
    const value = message(1)
    delete value.file_item_id
    delete value.thread_root_id
    delete value.is_whisper
    store.ingest('account', { writes: [{ type: 'put', message: { ...value, image_dimensions: { width: 10, height: 20 } } }], revisions: [] })
    expect(store.page('account', { chatId: 'chat', limit: 10 }).rows).toEqual([value])
    const row = fixture!.sqlite.prepare('SELECT * FROM im_messages').get() as Record<string, unknown>
    const rest = JSON.parse(String(row.rest))
    expect(Object.keys(rest).filter(key => key in row)).toEqual([])
    expect(rest).not.toHaveProperty('image_dimensions')
    expect(fixture!.sqlite.pragma('table_info(im_messages)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'item' })]))
  })

  it('e6 refuses an uncovered interval while accepting known visible gaps', async () => {
    const store = await openStore()
    const rows = [...Array.from({ length: 50 }, (_, i) => message(i + 1)), ...Array.from({ length: 51 }, (_, i) => message(i + 80))]
    store.ingest('account', { writes: rows.map(value => ({ type: 'put', message: value })), revisions: [], ranges: [
      { chatId: 'chat', fromSeq: 1, toSeq: 50 }, { chatId: 'chat', fromSeq: 80, toSeq: 130 },
    ] })
    expect(store.page('account', { chatId: 'chat', beforeSeq: 80, limit: 30 })).toMatchObject({ covered: false })
    expect(store.page('account', { chatId: 'chat', beforeSeq: 110, limit: 30 })).toMatchObject({ covered: true })
    expect(store.page('account', { chatId: 'chat', beforeSeq: 51, limit: 60 })).toMatchObject({ covered: true })
    store.ingest('account', { writes: [], revisions: [], ranges: [{ chatId: 'chat', fromSeq: 51, toSeq: 79 }] })
    expect(store.page('account', { chatId: 'chat', beforeSeq: 80, limit: 30 }).covered).toBe(true)
    expect(fixture!.sqlite.prepare('SELECT from_seq,to_seq FROM im_message_ranges').all()).toEqual([{ from_seq: 1, to_seq: 130 }])
    store.ingest('account', { writes: [{ type: 'truncateRange', chatId: 'chat' }], revisions: [] })
    expect(store.page('account', { chatId: 'chat', beforeSeq: 80, limit: 30 }).covered).toBe(false)
    store.clearAccount('account')
    expect(fixture!.sqlite.prepare('SELECT * FROM im_message_ranges').all()).toEqual([])
  })

  it('invalidates observer coverage when joining instead of bridging unseen topic revisions', async () => {
    const store = await openStore()
    store.ingest('account', { writes: [
      { type: 'chatAccess', access: { chatId: 'chat', ownMember: false, sourceChatId: 'source', revision: '1' } },
      ...Array.from({ length: 50 }, (_, i) => ({ type: 'put' as const, message: message(i + 1) })),
    ], revisions: [], ranges: [{ chatId: 'chat', fromSeq: 1, toSeq: 50 }] })
    store.ingest('account', { writes: [], revisions: [
      { revision: '2', writes: [{ type: 'chatAccess', access: { chatId: 'chat', ownMember: true } }] },
      { revision: '3', writes: [{ type: 'put', message: message(201) }] },
    ], throughRevision: '3' })
    expect(store.page('account', { chatId: 'chat', beforeSeq: 201, limit: 30 }).covered).toBe(false)
    expect(store.page('account', { chatId: 'chat', limit: 100 }).rows).toHaveLength(51)
  })
})

describe('0046 revision ingestion', () => {
  it('e1/e7 commits one native revision page before its IDB cursor and consumes the delivery inbox to zero', async () => {
    const store = await openStore()
    const invoke = installStore(store)
    const adapter = createMemoryLocalSyncDb()
    const prepare = vi.spyOn(adapter, 'prepareLocalMessages')
    const commit = vi.spyOn(adapter, 'commit')
    const repository = await openImRepository('account', { adapter })
    await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
    const raw = { ...message(1), entity_id: 'chat-1' }
    let calls = 0
    const coordinator = createAccountRevisionCoordinator('account', repository, {
      syncSince: async () => ++calls === 1 ? { operations: [
        { revision: '1', event: 'message_created', payload: { chat_id: 'chat', entity_id: raw.id, message: raw } },
        { revision: '2', event: 'presence_changed', payload: { agent_user_id: 'agent' } },
      ], hasMore: false } : { operations: [], hasMore: false },
      subscribeWake: () => () => {},
    })
    coordinator.subscribe(['message_created', 'presence_changed'], async () => {
      expect(store.page('account', { chatId: 'chat', limit: 10 }).rows).toHaveLength(1)
      expect(repository.snapshot().view.filter(row => row.key.startsWith('account-revision-operation:'))).toHaveLength(2)
    })
    coordinator.start()
    await coordinator.whenIdle()
    coordinator.stop()
    expect(repository.snapshot().view.filter(row => row.key.startsWith('account-revision-operation:'))).toEqual([])
    expect(invoke.mock.calls.filter(([channel]) => channel === 'imMessages.ingest')).toHaveLength(1)
    expect(store.throughRevision('account')).toBe('2')
    expect(prepare).toHaveBeenCalledTimes(1)
    const writes = commit.mock.calls.flatMap(([operations]) => operations)
    expect(writes.filter(write => write.type === 'put' && (write.store === 'message' || write.store === 'stream'))).toEqual([])
    expect(writes.filter(write => write.type === 'clearAccount')).toEqual([])
    repository.close()
  })

  it('e4 keeps bounded hot windows equal to real SQLite queries across mixed writes and renderer restarts', async () => {
    const store = await openStore()
    const invoke = installStore(store)
    await initializeMessages('account', createMemoryLocalSyncDb())
    let seed = 54321
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0)
    for (let i = 0; i < 55; i++) {
      const chatId = random() % 2 ? 'chat' : 'other'
      const seq = random() % 180 + 1
      await ingestMessages('account', { writes: random() % 4 ? [{ type: 'put', message: message(seq, chatId) }]
        : [{ type: 'delete', chatId, id: `${chatId}-${seq}` }], revisions: [] })
      if (i % 9 === 0) {
        clearMessageWindows('account')
        await initializeMessages('account', createMemoryLocalSyncDb())
        await Promise.all(['chat', 'other'].map(chat => readMessageWindowFromStore('account', chat)))
      }
      for (const chat of ['chat', 'other']) expect(messageWindow('account', chat)).toEqual(store.windows('account', [chat], 120))
    }
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    releaseMessageWindows('account', 'chat')
    invoke.mockImplementationOnce(async channel => {
      expect(channel).toBe('imMessages.page')
      const page = store.page('account', { chatId: 'chat', threadRootId: null, limit: 120 })
      await delayed
      return page
    })
    const pending = readMessageWindowFromStore('account', 'chat')
    await ingestMessages('account', 'clear')
    release(); await pending
    expect(messageWindow('account', 'chat')).toBeNull()
    await expect(ingestMessages('account', { writes: [{ type: 'put', message: message(200) }], revisions: [] }))
      .rejects.toMatchObject({ name: 'AbortError' })
    expect(store.windows('account', ['chat'], 120)).toEqual([])
  })

  it('holds a window only from its read until release; arrivals during the read land in it', async () => {
    const store = await openStore()
    const invoke = installStore(store)
    await initializeMessages('account', createMemoryLocalSyncDb())
    await ingestMessages('account', { writes: [1, 2, 3].map(seq => ({ type: 'put' as const, message: message(seq) })), revisions: [] })
    expect(isMessageWindowHeld('account', 'chat')).toBe(false)
    expect(messageWindow('account', 'chat')).toEqual([])
    let release!: () => void
    const delayed = new Promise<void>(resolve => { release = resolve })
    invoke.mockImplementationOnce(async channel => {
      expect(channel).toBe('imMessages.page')
      const page = store.page('account', { chatId: 'chat', threadRootId: null, limit: 120 })
      await delayed
      return page
    })
    const pending = readMessageWindowFromStore('account', 'chat')
    expect(readMessageWindowFromStore('account', 'chat')).toBe(pending)
    await ingestMessages('account', { writes: [{ type: 'put', message: message(4) }], revisions: [] })
    release(); await pending
    expect(messageWindow('account', 'chat')).toEqual(store.windows('account', ['chat'], 120))
    expect(messageWindow('account', 'chat')!.map(row => row.seq)).toEqual([1, 2, 3, 4])
    expect(readMessageWindowFromStore('account', 'chat')).toBeNull()
    await ingestMessages('account', { writes: [{ type: 'put', message: message(5, 'other') }], revisions: [] })
    expect(isMessageWindowHeld('account', 'other')).toBe(false)
    releaseMessageWindows('account', 'chat')
    expect(isMessageWindowHeld('account', 'chat')).toBe(false)
    expect(messageWindow('account', 'chat')).toEqual([])
  })

  it('advances a revision page past malformed bodies and excludes imported history roots', async () => {
    const store = await openStore()
    installStore(store)
    const repository = await openImRepository('account', { adapter: createMemoryLocalSyncDb() })
    await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
    await ingestMessages('account', { writes: [{ type: 'put', message: message(1) }], revisions: [],
      throughRevision: '0', ranges: [{ chatId: 'chat', fromSeq: 1, toSeq: 50 }] })
    const operations = [
      { revision: '1', event: 'message_created', payload: { chat_id: 'chat', entity_id: 'chat-2',
        message: { ...message(2), file_metadata: { invalid: true } } } },
      { revision: '2', event: 'message_created', payload: { chat_id: 'chat', entity_id: 'chat-3',
        message: { ...message(3), is_imported_history_root: true } } },
      { revision: '3', event: 'message_created', payload: { chat_id: 'other', entity_id: 'other-4', message: message(4, 'other') } },
    ]
    const runtime = createAccountRevisionRuntime('account', repository, {
      syncSince: async () => ({ operations, hasMore: false }), subscribeWake: () => () => {},
    })
    runtime.start()
    await runtime.whenIdle()
    runtime.stop()
    expect(store.throughRevision('account')).toBe('3')
    expect(repository.snapshot().sync_state.find(row => row.key === 'account-revision-cursor')!.value).toEqual({ revision: '3' })
    expect(store.page('account', { chatId: 'chat', beforeSeq: 51, limit: 30 })).toMatchObject({ covered: false })
    expect(store.windows('account', ['chat', 'other'], 120).map(row => row.id)).toEqual(['chat-1', 'other-4'])
    repository.close()
  })

  it('e5 replays after a native commit and rejected IDB commit without resurrecting deleted rows', async () => {
    const store = await openStore()
    installStore(store)
    const adapter = createMemoryLocalSyncDb()
    const repository = await openImRepository('account', { adapter })
    await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
    store.ingest('account', { writes: [{ type: 'put', message: message(1) }], revisions: [], throughRevision: '0' })
    const operations = [
      { revision: '1', event: 'message_deleted', payload: { chat_id: 'chat', entity_id: 'chat-1' } },
      { revision: '2', event: 'message_created', payload: { chat_id: 'chat', entity_id: 'chat-2', message: message(2) } },
    ]
    vi.spyOn(adapter, 'commit').mockRejectedValueOnce(new Error('crash before IDB cursor'))
    const source = { syncSince: async () => ({ operations, hasMore: false }), subscribeWake: () => () => {} }
    const runtime = createAccountRevisionRuntime('account', repository, source)
    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('crash before IDB cursor')
    runtime.stop()
    expect(repository.snapshot().sync_state.find(row => row.key === 'account-revision-cursor')!.value).toEqual({ revision: '0' })
    const secondConnection = new Database(fixture!.sqlite.name)
    try {
      const reopened = createImMessageStore(secondConnection)
      installStore(reopened)
      const replay = createAccountRevisionRuntime('account', repository, source)
      replay.start()
      await replay.whenIdle()
      replay.stop()
      expect(reopened.throughRevision('account')).toBe('2')
      expect(reopened.page('account', { chatId: 'chat', limit: 10 }).rows.map(row => row.id)).toEqual(['chat-2'])
      expect(repository.snapshot().sync_state.find(row => row.key === 'account-revision-cursor')!.value).toEqual({ revision: '2' })
    } finally { secondConnection.close(); repository.close() }
  })

  it('starts a first upgrade at S without a historical sync and replays a retained T before publishing', async () => {
    const store = await openStore()
    installStore(store)
    await initializeMessages('account', createMemoryLocalSyncDb())
    await readMessageWindowFromStore('account', 'chat') // a pane shows the conversation
    const syncSince = vi.fn(async () => ({ operations: [
      { revision: '11', event: 'message_deleted', payload: { chat_id: 'chat', entity_id: 'chat-1' } },
      { revision: '12', event: 'message_created', payload: { chat_id: 'chat', entity_id: 'chat-2', message: message(2) } },
    ], hasMore: false }))
    const signal = new AbortController().signal
    await alignMessageStore('account', '10', { syncSince }, signal)
    expect(syncSince).not.toHaveBeenCalled()
    expect(store.throughRevision('account')).toBe('10')
    await ingestMessages('account', { writes: [{ type: 'put', message: message(1) }], revisions: [] })
    await alignMessageStore('account', '12', { syncSince }, signal)
    expect(syncSince).toHaveBeenCalledExactlyOnceWith('10', 100, signal)
    expect(messageWindow('account', 'chat')?.map(row => row.id)).toEqual(['chat-2'])
    expect(store.throughRevision('account')).toBe('12')
  })

  it('clears rows and ranges only on an explicit server revision gap, keeping them on an ordinary offline failure', async () => {
    const store = await openStore()
    installStore(store)
    await initializeMessages('account', createMemoryLocalSyncDb())
    await ingestMessages('account', { writes: [{ type: 'put', message: message(1) }], revisions: [],
      throughRevision: '10', ranges: [{ chatId: 'chat', fromSeq: 1, toSeq: 50 }] })
    const syncSince = vi.fn().mockRejectedValueOnce(new Error('Failed to fetch'))
    const signal = new AbortController().signal
    await expect(alignMessageStore('account', '12', { syncSince }, signal)).rejects.toThrow('Failed to fetch')
    expect(store.throughRevision('account')).toBe('10')
    expect(store.page('account', { chatId: 'chat', beforeSeq: 51, limit: 10 }).covered).toBe(true)
    syncSince.mockRejectedValueOnce(new Error('revision gap after 10, first available 12'))
    await alignMessageStore('account', '12', { syncSince }, signal)
    expect(store.throughRevision('account')).toBe('12')
    expect(store.page('account', { chatId: 'chat', beforeSeq: 51, limit: 10 })).toEqual({ rows: [], covered: false })
  })
})

describe('0046 network sources store before they return', () => {
  const rootId = '11111111-1111-4111-8111-111111111111'
  const raw = (seq = 1) => ({ id: `message-${seq}`, chat_id: 'chat', seq, sender_user_id: 'account',
    content_type: 'text', content: `orchid ${seq}`, created_at: '2026-11-03T00:00:00Z' })
  let store: ReturnType<typeof createImMessageStore>
  let repository: Awaited<ReturnType<typeof openImRepository>>
  const stored = () => store.page('account', { chatId: 'chat', limit: 100 }).rows

  beforeEach(async () => {
    network.rows = [raw()]
    network.reactions = []
    network.from.mockImplementation((table: string) => {
      const data = () => table === 'messages_view' ? network.rows : table === 'message_reactions' ? network.reactions : []
      const chain = {
        select: () => chain, eq: () => chain, is: () => chain, not: () => chain, or: () => chain,
        lt: () => chain, gt: () => chain, order: () => chain, in: () => chain,
        limit: async () => ({ data: data(), error: null }),
        maybeSingle: async () => ({ data: table === 'chats' ? { kind: 'group' } : data()[0] ?? null, error: null }),
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: data(), error: null }).then(resolve),
      }
      return chain
    })
    store = await openStore()
    installStore(store)
    const adapter = createMemoryLocalSyncDb()
    repository = await openImRepository('account', { adapter })
    // The dev counterfactual gets the same empty SQL observation sink without retrofitting any writer.
    if (messageWindow('account', '') === null) await initializeMessages('account', adapter)
  })
  afterEach(() => repository?.close())

  it('e2 stores a revision for a conversation that has never been opened', async () => {
    await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
    const runtime = createAccountRevisionRuntime('account', repository, {
      syncSince: async () => ({ operations: [{ revision: '1', event: 'message_created',
        payload: { chat_id: 'chat', entity_id: 'message-1', message: raw() } }], hasMore: false }),
      subscribeWake: () => () => {},
    })
    runtime.start(); await runtime.whenIdle(); runtime.stop()
    expect(stored().map(row => row.id)).toEqual(['message-1'])
  })

  it('e2 stores an older network page before history pagination returns it', async () => {
    const rows = await fetchChatHistoryPage('account')('chat', 'older', 80, 30)
    expect(rows).toHaveLength(1)
    expect(stored().map(row => row.id)).toEqual(['message-1'])
  })

  it('e2 stores the first network screen before getMessages returns it', async () => {
    expect(await chatService.getMessages('chat', 'account', 'initialLoad')).toHaveLength(1)
    expect(stored().map(row => row.id)).toEqual(['message-1'])
  })

  it('e2 stores the anchor and its network context before restoring a viewport', async () => {
    const window = { restoreAnchor: async (read: (chatId: string) => Promise<unknown>) => { await read('chat'); return true } } as ChatHistoryWindow
    expect(await restoreChatHistoryAnchor(window, 'account', 'message-1')).toBe(true)
    expect(stored().map(row => row.id)).toEqual(['message-1'])
  })

  it('e2 stores the forward network page used to heal a message gap', async () => {
    network.rows = [raw(51)]
    expect(await chatService.getMessages('chat', 'account', 'loadNewer', 60, undefined, 50)).toHaveLength(1)
    expect(stored().map(row => row.id)).toEqual(['message-51'])
  })

  it('e2 stores thread replies before their thread fetch returns', async () => {
    network.rows = [{ ...raw(2), thread_root_id: rootId }]
    expect(await chatService.getThreadMessages('chat', rootId, 'account', 100)).toHaveLength(1)
    expect(store.page('account', { chatId: 'chat', threadRootId: rootId, limit: 100 }).rows.map(row => row.id)).toEqual(['message-2'])
  })

  it('e2 stores a send acknowledgement before removing its durable outbox row', async () => {
    await putOutboxRecord(repository, { clientMessageId: 'message-1', chatId: 'chat', senderUserId: 'account',
      payload: { content: 'orchid 1', contentType: 'text', toUserIds: null, replyToMessageId: null,
        threadRootId: null, isThreadRoot: false, isWhisper: false },
      state: 'pending', attempts: 0, lastError: null, enqueuedAt: '2026-11-03T00:00:00Z', updatedAt: '2026-11-03T00:00:00Z' })
    await ackOutboxRecord(repository, 'message-1', messageItemFromRow(raw(), 'account')!)
    expect(stored().map(row => row.id)).toEqual(['message-1'])
    expect(repository.snapshot().outbox).toEqual([])
  })

  it('e2 persists a server reaction on the canonical SQLite row rather than a view copy', async () => {
    store.ingest('account', { writes: [{ type: 'put', message: messageItemFromRow(raw(), 'account')! }], revisions: [] })
    network.reactions = [{ message_id: 'message-1', user_id: 'account', emoji: 'x' }]
    await loadMessageOverlays(['message-1'], 'account')
    expect(stored()[0]!.reactions).toEqual([{ emoji: 'x', count: 1, my_reaction: true }])
  })
})
