// @vitest-environment node
// 投影一批只脏了一条会话:未读只问那一条(从前每一批都把所有会话的所有流重算一遍整包拿回);投递回执不改会话行,不重读它。
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Response = { data: unknown; error: { message: string } | null }
const calls: Array<{ key: string; args?: unknown }> = []
const refuse = new Set<string>()
const rowsByKey = new Map<string, unknown[]>()
function builder(key: string, args?: unknown): unknown {
  const chain: unknown = new Proxy(function noop() {} as unknown as object, {
    get(_target, prop) {
      if (prop === 'then') {
        return (onFulfilled: (value: Response) => unknown, onRejected?: (reason: unknown) => unknown) => {
          calls.push({ key, args })
          const chatId = (args as { p_chat_ids?: string[] } | undefined)?.p_chat_ids?.[0]
          const result: Response = chatId && refuse.has(chatId)
            ? { data: null, error: { message: `not authorized to read unread locator for chat ${chatId}` } }
            : { data: rowsByKey.get(key) ?? [], error: null }
          return Promise.resolve(result).then(onFulfilled, onRejected)
        }
      }
      return () => chain
    },
    apply: () => chain,
  })
  return chain
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (table: string) => builder(table), rpc: (fn: string, args: unknown) => builder(`rpc:${fn}`, args) },
  identityDb: { from: (table: string) => builder(table), rpc: (fn: string, args: unknown) => builder(`rpc:${fn}`, args) },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: readonly string[]) => ids.map((id) => ({ id, display_name: `name-${id}`, type: 'human' })),
}))
const accessWrites = vi.hoisted(() => [] as unknown[])
vi.mock('../../../../apps/desktop/src/lib/messageIngest', () => ({
  ingestMessages: async (_account: string, batch: { writes: unknown[] }) => { accessWrites.push(...batch.writes) },
}))
const { createChatProjection, toProjectionOperations } = await import('../../../../apps/desktop/src/lib/chatProjection')

const VIEWER = 'u-viewer'
const chats = ['c-1', 'c-2', 'c-3']
function seed(): void {
  const seats = chats.map((chat_id) => ({
    chat_id, user_id: VIEWER, last_read_seq: 0, is_marked_unread: false, version: 1, notification_level: 'all', is_pinned: false,
    updated_at: '2026-10-29T00:00:00Z', joined_at: '2026-10-29T00:00:00Z', inbox_published_at: '2026-10-29T00:00:00Z',
  }))
  rowsByKey.set('chat_members', seats); rowsByKey.set('active_members', seats)
  rowsByKey.set('chats', chats.map((id) => ({
    id, public_id: null, kind: 'group', status: 'active', name: id, avatar_url: null, created_at: '2026-10-29T00:00:00Z',
    last_message_at: null, last_message_preview: null, next_message_seq: 1, pinned_message_id: null,
  })))
  rowsByKey.set('rpc:list_chat_previews', []); rowsByKey.set('rpc:list_unread_locators_for_chats', []); rowsByKey.set('contact_overrides', [])
}
const unreadArgs = () => calls.filter((call) => call.key === 'rpc:list_unread_locators_for_chats').map((call) => (call.args as { p_chat_ids: string[] }).p_chat_ids)

beforeEach(() => { calls.length = 0; accessWrites.length = 0; refuse.clear(); seed() })

describe('chat projection read scope', () => {
  it('a message in one chat records access facts for that chat only, not for every known chat', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    expect(new Set(accessWrites.map((write) => (write as { access: { chatId: string } }).access.chatId))).toEqual(new Set(chats))
    accessWrites.length = 0
    await projection.advance([{ revision: '1', event: 'message_created', chatId: 'c-2', entityId: 'm-1' }], '1', signal)
    expect(new Set(accessWrites.map((write) => (write as { access: { chatId: string } }).access.chatId))).toEqual(new Set(['c-2']))
  })

  it('a message in one chat asks the unread projection for that chat only', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    await projection.advance([{ revision: '1', event: 'message_created', chatId: 'c-2', entityId: 'm-1' }], '1', signal)
    expect(unreadArgs()).toEqual([['c-2']])
  })

  it('a batch over two chats asks only for those chats in one call', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    await projection.advance([
      { revision: '1', event: 'message_created', chatId: 'c-1', entityId: 'm-1' },
      { revision: '2', event: 'message_created', chatId: 'c-3', entityId: 'm-2' },
    ], '2', signal)
    expect(unreadArgs()).toEqual([['c-1', 'c-3']])
  })

  it('a scoped read failure stays loud and never falls back to the full list', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    refuse.add('c-2')
    await expect(projection.advance([{ revision: '1', event: 'member_read_changed', chatId: 'c-2', entityId: null }], '1', signal)).rejects.toThrow(/not authorized/)
    expect(unreadArgs()).toEqual([['c-2']])
  })

  it('a delivery receipt re-reads preview and unread, not the chat row', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    await projection.advance([{ revision: '1', event: 'delivery_changed', chatId: 'c-1', entityId: 'm-1' }], '1', signal)
    const keys = calls.map((call) => call.key)
    expect(keys).not.toContain('chats')
    expect(keys).toContain('rpc:list_chat_previews')
    expect(unreadArgs()).toEqual([['c-1']])
  })

  it('clearing a manual unread mark on my own seat re-reads that chat\'s unread, though the read cursor did not move', async () => {
    // mark_stream_read on a chat marked unread at its tail: last_read_seq stays, so no member_read_changed —
    // the only journal entry is chat_members_changed kind 'own' (20261102035000_membership_revision_kind).
    rowsByKey.set('rpc:list_unread_locators_for_chats', [{ chat_id: 'c-2', stream_id: 'main:c-2', stream_kind: 'main', thread_root_id: null,
      message_id: 'm-1', message_seq: 1, unread_count: 1, addressed_count: 1, cursor_seq: 1, version: 2, is_marked_unread: true }])
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    expect((await projection.hydrate('0', signal)).find((row) => row.id === 'c-2')?.unread_count).toBe(1)
    rowsByKey.set('rpc:list_unread_locators_for_chats', [])
    calls.length = 0
    const rows = await projection.advance(toProjectionOperations([{ revision: '1', event: 'chat_members_changed',
      payload: { chat_id: 'c-2', user_id: VIEWER, kind: 'own', tombstone: false } }]), '1', signal)
    expect(unreadArgs()).toEqual([['c-2']])
    expect(rows?.find((row) => row.id === 'c-2')?.unread_count).toBe(0)
  })

  it('another member\'s roster change does not re-read my unread', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    await projection.advance(toProjectionOperations([{ revision: '1', event: 'chat_members_changed',
      payload: { chat_id: 'c-2', user_id: 'u-other', kind: 'roster', tombstone: false } }]), '1', signal)
    expect(unreadArgs()).toEqual([])
  })
})
