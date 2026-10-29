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
          const chatId = (args as { p_chat_id?: string | null } | undefined)?.p_chat_id
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
const { createChatProjection } = await import('../../../../apps/desktop/src/lib/chatProjection')

const VIEWER = 'u-viewer'
const chats = ['c-1', 'c-2', 'c-3']
function seed(): void {
  rowsByKey.set('chat_members', chats.map((chat_id) => ({
    chat_id, user_id: VIEWER, last_read_seq: 0, is_marked_unread: false, version: 1, notification_level: 'all', is_pinned: false,
    updated_at: '2026-10-29T00:00:00Z', joined_at: '2026-10-29T00:00:00Z', inbox_published_at: '2026-10-29T00:00:00Z',
  })))
  rowsByKey.set('chats', chats.map((id) => ({
    id, public_id: null, kind: 'group', status: 'active', name: id, avatar_url: null, created_at: '2026-10-29T00:00:00Z',
    last_message_at: null, last_message_preview: null, next_message_seq: 1, pinned_message_id: null,
  })))
  rowsByKey.set('messages_view', []); rowsByKey.set('rpc:list_unread_locators', []); rowsByKey.set('contact_overrides', [])
}
const unreadArgs = () => calls.filter((call) => call.key === 'rpc:list_unread_locators').map((call) => (call.args as { p_chat_id: string | null }).p_chat_id)

beforeEach(() => { calls.length = 0; refuse.clear(); seed() })

describe('chat projection read scope', () => {
  it('a message in one chat asks the unread projection for that chat only', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    await projection.advance([{ revision: '1', event: 'message_created', chatId: 'c-2', entityId: 'm-1' }], '1', signal)
    expect(unreadArgs()).toEqual(['c-2'])
  })

  it('a batch over two chats still asks for everything in one call', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    await projection.advance([
      { revision: '1', event: 'message_created', chatId: 'c-1', entityId: 'm-1' },
      { revision: '2', event: 'message_created', chatId: 'c-3', entityId: 'm-2' },
    ], '2', signal)
    expect(unreadArgs()).toEqual([null])
  })

  it('a chat the server no longer lets me read falls back to the full list (its missing row is the tombstone)', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    refuse.add('c-2')
    await projection.advance([{ revision: '1', event: 'member_read_changed', chatId: 'c-2', entityId: null }], '1', signal)
    expect(unreadArgs()).toEqual(['c-2', null])
  })

  it('a delivery receipt re-reads preview and unread, not the chat row', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    await projection.hydrate('0', signal)
    calls.length = 0
    await projection.advance([{ revision: '1', event: 'delivery_changed', chatId: 'c-1', entityId: 'm-1' }], '1', signal)
    const keys = calls.map((call) => call.key)
    expect(keys).not.toContain('chats')
    expect(keys).toContain('messages_view')
    expect(unreadArgs()).toEqual(['c-1'])
  })
})
