// @vitest-environment jsdom
// 会话列表每次更新的读:只读这一批脏了的会话,走两条集合 RPC;列表不显示的事实(回应、设备回执、别人的读位)一发不读。
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { displayIdentity as identity } from '../../../support/testHarness'
import type { ChatItem } from '@gugu/core/shared/types/chat'

const calls: Array<{ key: string; args?: unknown }> = []
const rows = new Map<string, unknown[]>()
const errors = new Set<string>()
let pausePreview: (() => Promise<void>) | null = null
function request(key: string, args?: unknown): unknown {
  const chain: unknown = new Proxy({}, { get: (_, prop) => prop === 'then'
    ? (resolve: (value: unknown) => unknown) => {
      calls.push({ key, args })
      const result = errors.has(key) ? { data: null, error: { message: 'read failed' } } : { data: rows.get(key) ?? [], error: null }
      return (key === 'list_chat_previews' && pausePreview ? pausePreview() : Promise.resolve()).then(() => result).then(resolve)
    } : () => chain })
  return chain
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (key: string) => request(key), rpc: (key: string, args: unknown) => request(key, args) },
  identityDb: { from: (key: string) => request(key), rpc: (key: string, args: unknown) => request(key, args) },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: string[]) => {
    if (errors.has('identity')) throw new Error('identity read failed')
    return ids.map(id => identity(id))
  },
}))
const { createChatProjection, toProjectionOperations } = await import('../../../../apps/desktop/src/lib/chatProjection')
const viewer = 'viewer'
const signal = new AbortController().signal
afterEach(() => vi.restoreAllMocks())
const time = '2026-11-02T10:00:00Z'
const locator = (root: string, count: number) => ({ chat_id: 'c1', stream_id: `thread:c1:${root}`,
  stream_kind: 'thread', thread_root_id: root, message_id: `first-${root}`, message_seq: 6,
  unread_count: count, addressed_count: count, cursor_seq: 0, version: 1, is_marked_unread: false })
beforeEach(() => {
  calls.length = 0; rows.clear(); errors.clear(); pausePreview = null
  rows.set('active_members', ['c1', 'c2', 'c3'].map(chat_id => ({ chat_id, user_id: viewer,
    last_read_seq: 0, is_marked_unread: false, version: 1, notification_level: 'all', is_pinned: false,
    joined_at: time, updated_at: time, inbox_published_at: time })))
  rows.set('chats', ['c1', 'c2', 'c3'].map(id => ({ id, kind: 'group', status: 'active', name: id,
    created_at: time, last_message_at: time, last_message_preview: 'before', next_message_seq: 21 })))
  rows.set('list_chat_previews', ['c1', 'c2', 'c3'].map(chat_id => ({ chat_id, id: `old-${chat_id}`, seq: 20,
    created_at: time, preview: 'before', content_type: 'text', sender_user_id: 'peer', client_message_id: null })))
  rows.set('list_unread_locators_for_chats', [locator('a', 4), locator('b', 8)])
})
async function hydrated() {
  const owner = createChatProjection(viewer)
  expect(await owner.hydrate('0', signal)).toHaveLength(3)
  calls.length = 0
  return owner
}
const advance = (owner: ReturnType<typeof createChatProjection>, event: string, payload: unknown, revision = '1') =>
  owner.advance(toProjectionOperations([{ revision, event, payload }]), revision, signal)
const reads = (key: string) => calls.filter(call => call.key === key).map(call => call.args)
const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

it('hydrates with one preview read and one unread read over the explicit chat array', async () => {
  const owner = createChatProjection(viewer)
  await owner.hydrate('0', signal)
  expect(reads('list_chat_previews')).toEqual([{ p_chat_ids: ['c1', 'c2', 'c3'] }])
  expect(reads('list_unread_locators_for_chats')).toEqual([{ p_chat_ids: ['c1', 'c2', 'c3'] }])
  expect(calls.some(call => call.key === 'messages_view' || call.key === 'list_unread_locators')).toBe(false)
})

it('reads nothing for reactions, device receipts or another member\'s read cursor', async () => {
  const owner = await hydrated()
  await advance(owner, 'member_read_changed', { chat_id: 'c1', entity_id: 'peer', last_read_seq: 20 })
  await advance(owner, 'member_stream_read_changed', { chat_id: 'c1', entity_id: 'peer', stream_id: 'thread:c1:a', last_read_seq: 20 }, '2')
  await advance(owner, 'delivery_changed', { chat_id: 'c1', entity_id: 'old-c1', device_id: 'agent:peer', status: 'read' }, '3')
  await advance(owner, 'reaction_changed', { chat_id: 'c1', entity_id: 'old-c1' }, '4')
  expect(calls).toEqual([])
  expect(owner.current().find(chat => chat.id === 'c1')?.unread_count).toBe(12)
})

it('re-reads my unread for only the chat I read', async () => {
  const owner = await hydrated()
  rows.set('list_unread_locators_for_chats', [locator('b', 8)])
  await advance(owner, 'member_read_changed', { chat_id: 'c1', entity_id: viewer, last_read_seq: 20 })
  expect(reads('list_unread_locators_for_chats')).toEqual([{ p_chat_ids: ['c1'] }])
  expect(owner.current().find(chat => chat.id === 'c1')?.unread_count).toBe(8)
})

it('reads a new message\'s chat only, through the set RPCs', async () => {
  const owner = await hydrated()
  rows.set('list_chat_previews', [{ chat_id: 'c2', id: 'new', seq: 21, created_at: time, preview: 'new',
    content_type: 'text', sender_user_id: 'peer', client_message_id: null }])
  await advance(owner, 'message_created', { chat_id: 'c2', entity_id: 'new' })
  expect(reads('list_chat_previews')).toEqual([{ p_chat_ids: ['c2'] }])
  expect(reads('list_unread_locators_for_chats')).toEqual([{ p_chat_ids: ['c2'] }])
  expect(owner.current().find(chat => chat.id === 'c2')?.last_message_preview).toBe('new')
})

// @@@incremental-list: a message re-assembles its own conversation; every other row is the object it was.
it('re-assembles only the conversation a new message touched', async () => {
  const owner = await hydrated()
  const before = new Map(owner.current().map(chat => [chat.id, chat]))
  const identities = owner.identities()
  rows.set('list_chat_previews', [{ chat_id: 'c2', id: 'new', seq: 21, created_at: '2026-11-02T11:00:00Z', preview: 'new',
    content_type: 'text', sender_user_id: 'peer', client_message_id: null }])
  await advance(owner, 'message_created', { chat_id: 'c2', entity_id: 'new' })
  const after = owner.current()
  expect(after.map(chat => chat.id)).toEqual(['c2', 'c1', 'c3'])
  expect(after[0]).not.toBe(before.get('c2'))
  expect(after[1]).toBe(before.get('c1'))
  expect(after[2]).toBe(before.get('c3'))
  expect(after[0]!.member_user_ids).toBe(before.get('c2')!.member_user_ids)
  expect(owner.identities()).toBe(identities)
})

it('fails loudly on a refused unread read instead of asking for the whole list', async () => {
  const owner = await hydrated()
  errors.add('list_unread_locators_for_chats')
  await expect(advance(owner, 'message_created', { chat_id: 'c1', entity_id: 'new' })).rejects.toThrow('read failed')
  expect(calls.some(call => call.key === 'list_unread_locators')).toBe(false)
})

it('publishes the settled rows of a batch superseded by another conversation', async () => {
  const owner = await hydrated()
  const began = deferred(), waiting = deferred()
  pausePreview = () => { began.resolve(); return waiting.promise }
  rows.set('list_chat_previews', [{ chat_id: 'c1', created_at: time, preview: 'first' }])
  const first = advance(owner, 'message_created', { chat_id: 'c1', entity_id: 'm1' })
  await began.promise
  pausePreview = null
  rows.set('list_chat_previews', [{ chat_id: 'c2', created_at: time, preview: 'second' }])
  const second = advance(owner, 'message_created', { chat_id: 'c2', entity_id: 'm2' }, '2')
  waiting.resolve()
  await Promise.all([first, second])
  expect(owner.current().find(row => row.id === 'c1')?.last_message_preview).toBe('first')
  expect(owner.current().find(row => row.id === 'c2')?.last_message_preview).toBe('second')
})

it('keeps first-wave changes when a later wave fails and another conversation wakes the owner', async () => {
  const owner = await hydrated()
  const ingest = vi.spyOn(await import('../../../../apps/desktop/src/lib/messageIngest'), 'ingestMessages')
  rows.set('active_members', [...rows.get('active_members')!, { chat_id: 'c2', user_id: 'new-peer',
    last_read_seq: 0, is_marked_unread: false, version: 1, notification_level: 'all', is_pinned: false,
    joined_at: time, updated_at: time, inbox_published_at: time }])
  rows.set('list_chat_previews', [{ chat_id: 'c1', created_at: time, preview: 'first' }])
  errors.add('identity')
  await expect(owner.advance([
    ...toProjectionOperations([{ revision: '1', event: 'chat_changed', payload: { chat_id: 'c1' } }]),
    { revision: '1', event: 'chat_members_changed', chatId: 'c2', entityId: 'new-peer' },
  ], '1', signal)).rejects.toThrow('identity read failed')
  errors.delete('identity')
  rows.set('list_chat_previews', [{ chat_id: 'c3', created_at: time, preview: 'third' }])
  await advance(owner, 'message_created', { chat_id: 'c3', entity_id: 'm3' }, '2')
  expect(owner.current().find(row => row.id === 'c1')?.last_message_preview).toBe('first')
  expect(owner.current().find(row => row.id === 'c2')?.member_user_ids).toContain('new-peer')
  expect(owner.current().find(row => row.id === 'c3')?.last_message_preview).toBe('third')
  expect(ingest.mock.calls.at(-1)?.[1]).toMatchObject({ writes: expect.arrayContaining([
    { type: 'chatAccess', access: expect.objectContaining({ chatId: 'c1', revision: '1' }) },
  ]) })
})

it('does not consume pending message keys when another conversation is personally deleted', async () => {
  const owner = await hydrated()
  const beganA = deferred(), waitingA = deferred(), beganB = deferred(), waitingB = deferred()
  pausePreview = () => { beganA.resolve(); return waitingA.promise }
  rows.set('list_chat_previews', [{ chat_id: 'c1', created_at: time, preview: 'first' }])
  const first = advance(owner, 'message_created', { chat_id: 'c1', entity_id: 'm1' })
  await beganA.promise
  pausePreview = () => { beganB.resolve(); return waitingB.promise }
  rows.set('list_chat_previews', [{ chat_id: 'c2', created_at: time, preview: 'second' }])
  const second = advance(owner, 'message_created', { chat_id: 'c2', entity_id: 'm2' }, '2')
  waitingA.resolve()
  await first
  await beganB.promise
  owner.confirmPersonalDeletion({ chat_id: 'c3', deleted_at: time })
  waitingB.resolve()
  await second
  expect(owner.current().find(row => row.id === 'c1')?.last_message_preview).toBe('first')
  expect(owner.current().find(row => row.id === 'c2')?.last_message_preview).toBe('second')
  expect(owner.current().some(row => row.id === 'c3')).toBe(false)
})

// @@@one-row-object: the projection's snapshot and cache reuse what memory already holds — never a second equal set.
it('reuses the rows the chat list holds and the identities the repository holds when they are unchanged', async () => {
  rows.set('active_members', [...(rows.get('active_members') as object[]),
    { chat_id: 'd1', user_id: viewer, last_read_seq: 0, is_marked_unread: false, version: 1, notification_level: 'all',
      is_pinned: false, joined_at: time, updated_at: time, inbox_published_at: time },
    { chat_id: 'd1', user_id: 'peer', last_read_seq: 0, is_marked_unread: false, version: 1, notification_level: 'all',
      is_pinned: false, joined_at: time, updated_at: time, inbox_published_at: time }])
  rows.set('chats', [...(rows.get('chats') as object[]), { id: 'd1', kind: 'dm', status: 'active', name: null,
    created_at: time, last_message_at: time, last_message_preview: 'before', next_message_seq: 21 }])
  const listRows = structuredClone(await createChatProjection(viewer).hydrate('0', signal))
  const person = identity('peer')
  const owner = createChatProjection(viewer, { rows: () => listRows, identity: id => id === 'peer' ? person : undefined })
  const projected = await owner.hydrate('0', signal)
  expect(projected).toBe(listRows)
  expect(owner.identities().find(identity => identity.id === 'peer')).toBe(person)
})

it('converges a different cold-painted list and the projection to the same row objects after the first message', async () => {
  const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')
  const { imSelectors, openImRepository, replaceChatRowsAndIdentities } = await import('../../../../apps/desktop/src/lib/imRepository')
  const { paintLocalChats } = await import('../../../../apps/desktop/src/lib/chatSnapshotPublication')
  const { applyFetchedChatList, createChatListProjectionLedger } = await import('../../../../apps/desktop/src/store/chatListProjection')
  const repository = await openImRepository(viewer, { adapter: createMemoryLocalSyncDb() })
  try {
    const seed = createChatProjection(viewer)
    const initial = await seed.hydrate('0', signal)
    await replaceChatRowsAndIdentities(repository, initial.map(row => ({ ...row, last_message_preview: 'cold cache' })), seed.identities())
    const ledger = createChatListProjectionLedger()
    const visible = { current: [] as ChatItem[] }
    paintLocalChats(repository, { chatsRef: visible, projection: ledger,
      setChats: rows => { visible.current = typeof rows === 'function' ? rows(visible.current) : rows }, setChatsLoad: () => {} })
    const cold = visible.current
    const owner = createChatProjection(viewer, { rows: () => visible.current, identity: id => imSelectors.identitiesById(repository.snapshot())[id] })
    const snapshot = await owner.hydrate('0', signal)
    expect(snapshot[0]).not.toBe(cold[0])
    const accept = async (fetched: readonly ChatItem[]) => {
      visible.current = await applyFetchedChatList(ledger, repository, { fetched, identities: owner.identities() },
        { currentChats: visible.current, activeChatId: null, revokeMissingActive: false })
    }
    await accept(snapshot)
    rows.set('list_chat_previews', [{ chat_id: 'c2', id: 'new', seq: 21, created_at: '2026-11-02T11:00:00Z', preview: 'new',
      content_type: 'text', sender_user_id: 'peer', client_message_id: null }])
    const next = await advance(owner, 'message_created', { chat_id: 'c2', entity_id: 'new' })
    expect(next).not.toBeNull()
    await accept(next!)
    for (const row of owner.current()) expect(visible.current.find(current => current.id === row.id)).toBe(row)
  } finally { repository.close() }
})
