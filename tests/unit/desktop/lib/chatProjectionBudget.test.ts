// @vitest-environment node
// 会话列表每次更新的读:只读这一批脏了的会话,走两条集合 RPC;列表不显示的事实(回应、设备回执、别人的读位)一发不读。
import { beforeEach, expect, it, vi } from 'vitest'

const calls: Array<{ key: string; args?: unknown }> = []
const rows = new Map<string, unknown[]>()
const errors = new Set<string>()
function request(key: string, args?: unknown): unknown {
  const chain: unknown = new Proxy({}, { get: (_, prop) => prop === 'then'
    ? (resolve: (value: unknown) => unknown) => {
      calls.push({ key, args })
      return Promise.resolve(errors.has(key) ? { data: null, error: { message: 'read failed' } } : { data: rows.get(key === 'list_conversation_memberships' ? 'active_members' : key) ?? [], error: null }).then(resolve)
    } : () => chain })
  return chain
}
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (key: string) => request(key), rpc: (key: string, args: unknown) => request(key, args) },
  identityDb: { from: (key: string) => request(key), rpc: (key: string, args: unknown) => request(key, args) },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (ids: string[]) => ids.map(id => ({ id, display_name: id, type: 'human' })),
}))
const { createChatProjection, toProjectionOperations } = await import('../../../../apps/desktop/src/lib/chatProjection')
const viewer = 'viewer'
const signal = new AbortController().signal
const time = '2026-11-02T10:00:00Z'
const locator = (root: string, count: number) => ({ chat_id: 'c1', stream_id: `thread:c1:${root}`,
  stream_kind: 'thread', thread_root_id: root, message_id: `first-${root}`, message_seq: 6,
  unread_count: count, addressed_count: count, cursor_seq: 0, version: 1, is_marked_unread: false })
beforeEach(() => {
  calls.length = 0; rows.clear(); errors.clear()
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

it('fails loudly on a refused unread read instead of asking for the whole list', async () => {
  const owner = await hydrated()
  errors.add('list_unread_locators_for_chats')
  await expect(advance(owner, 'message_created', { chat_id: 'c1', entity_id: 'new' })).rejects.toThrow('read failed')
  expect(calls.some(call => call.key === 'list_unread_locators')).toBe(false)
})
