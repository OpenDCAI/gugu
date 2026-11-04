// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

type Row = Record<string, unknown>
type Response = { data: Row[] | null; error: { message: string } | null }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const VIEWER = 'snapshot-viewer'
const ids = Array.from({ length: 83 }, (_, index) => `chat-${String(index).padStart(3, '0')}`)
const changed = ids[26]!
const members = new Set<string>()
const calls: Array<{ table: string; ids?: readonly string[] }> = []
let keysetStarted = deferred<void>()
let releaseKeyset = deferred<void>()
let pauseKeyset = false
let failedKeyset = false

function builder(table: string) {
  let selection = ''
  let requested: readonly string[] | undefined
  const chain: unknown = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') {
        return (fulfilled: (value: Response) => unknown, rejected?: (reason: unknown) => unknown) => {
          const read = async (): Promise<Response> => {
            calls.push({ table, ids: requested })
            if (table === 'active_members' && selection === 'chat_id') {
              if (pauseKeyset) {
                pauseKeyset = false
                keysetStarted.resolve()
                await releaseKeyset.promise
              } else if (failedKeyset) {
                failedKeyset = false
                return { data: null, error: { message: 'snapshot keyset unavailable' } }
              }
              return { data: [...members].map((chat_id) => ({ chat_id })), error: null }
            }
            const batch = requested ?? ids
            if (table === 'active_members') return {
              data: batch.filter((id) => members.has(id)).map((chat_id) => ({
                chat_id, user_id: VIEWER, role: 'member', last_read_seq: 0,
                is_marked_unread: false, version: 1, is_pinned: false,
                notification_level: 'all', updated_at: '2026-11-04T00:00:00Z',
                joined_at: '2026-10-07T00:00:00Z', inbox_published_at: '2026-10-07T00:00:00Z',
              })), error: null,
            }
            if (table === 'chats') return {
              data: batch.map((id) => ({
                id, kind: 'group', status: 'active', name: id,
                created_at: '2026-10-07T00:00:00Z',
                last_message_at: id === changed ? '2026-11-04T04:49:41Z' : '2026-10-07T00:00:00Z',
                last_message_preview: null, next_message_seq: 4,
              })), error: null,
            }
            if (['messages_view', 'contact_overrides', 'rpc:list_unread_locators', 'rpc:get_agent_presence_batch'].includes(table)) {
              return { data: [], error: null }
            }
            throw new Error(`unexpected projection table ${table}`)
          }
          return read().then(fulfilled, rejected)
        }
      }
      if (property === 'select') return (value: string) => { selection = value; return chain }
      if (property === 'in') return (_column: string, values: readonly string[]) => { requested = [...values]; return chain }
      return () => chain
    },
  })
  return chain
}

vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (table: string) => builder(table), rpc: (name: string) => builder(`rpc:${name}`) },
  identityDb: { from: (table: string) => builder(table), rpc: (name: string) => builder(`rpc:${name}`) },
}))
vi.mock('../../../../apps/desktop/src/lib/identityReadAdapter', () => ({
  readDisplayIdentities: async (keys: readonly string[]) => keys.map((id) => ({ id, display_name: id, type: 'human' })),
}))

const { createChatProjection } = await import('../../../../apps/desktop/src/lib/chatProjection')

beforeEach(() => {
  members.clear()
  for (const id of ids) members.add(id)
  calls.length = 0
  keysetStarted = deferred<void>()
  releaseKeyset = deferred<void>()
  pauseKeyset = false
  failedKeyset = false
})

async function overlap(failNewer = false) {
  const projection = createChatProjection(VIEWER)
  const signal = new AbortController().signal
  pauseKeyset = true
  const initial = projection.hydrate('10', signal)
  await keysetStarted.promise
  // Same-account send/read arrives while the old-cursor full keyset is outstanding.
  const newer = projection.advance([
    { revision: '11', event: 'message_created', chatId: changed, entityId: 'new-message' },
    { revision: '12', event: 'member_read_changed', chatId: changed, entityId: VIEWER },
  ], '12', signal)
  failedKeyset = failNewer
  releaseKeyset.resolve()
  return { projection, signal, initial, newer }
}

describe('a newer revision overtakes a cold chat snapshot', () => {
  it('does not publish the 82-row partial snapshot or drop the newly active chat', async () => {
    const { projection, signal, initial, newer } = await overlap()
    const first = await initial
    expect(first).toHaveLength(ids.length)
    expect(first?.[0]?.id).toBe(changed)
    const final = await newer
    expect(final).toHaveLength(ids.length)
    expect(final?.[0]?.id).toBe(changed)
    expect(new Set(final?.map((row) => row.id))).toEqual(new Set(ids))
    expect(projection.current()).toEqual(final)
    // A captured overlapping request really omits one key; this is not a timer-based simulation.
    const firstBatch = calls.filter((call) => call.table === 'chats').slice(0, 2)
    expect(firstBatch.map((call) => call.ids?.length)).toEqual([68, 14])
    expect(firstBatch.flatMap((call) => call.ids ?? [])).not.toContain(changed)
    calls.length = 0
    expect(await projection.hydrate('12', signal)).toEqual(final)
    expect(calls).toHaveLength(0)
  })

  it('keeps the incomplete cold snapshot unpublished if the queued newer snapshot fails', async () => {
    const { projection, initial, newer } = await overlap(true)
    await Promise.all([
      expect(initial).rejects.toThrow('snapshot keyset unavailable'),
      expect(newer).rejects.toThrow('snapshot keyset unavailable'),
    ])
    expect(projection.current()).toEqual([])
    // The existing next wake, rather than a new retry loop, completes the full snapshot.
    const recovered = await projection.advance([
      { revision: '13', event: 'chat_changed', chatId: changed, entityId: null },
    ], '13', new AbortController().signal)
    expect(recovered).toHaveLength(ids.length)
    expect(recovered?.[0]?.id).toBe(changed)
  })

  it('still removes a conversation after its authoritative membership tombstone', async () => {
    const projection = createChatProjection(VIEWER)
    const signal = new AbortController().signal
    expect(await projection.hydrate('10', signal)).toHaveLength(ids.length)
    members.delete(changed)
    const next = await projection.advance([
      { revision: '11', event: 'chat_members_changed', chatId: changed, entityId: VIEWER },
    ], '11', signal)
    expect(next).toHaveLength(ids.length - 1)
    expect(next?.some((row) => row.id === changed)).toBe(false)
    expect(projection.isMembershipRevoked(changed)).toBe(true)
  })
})
