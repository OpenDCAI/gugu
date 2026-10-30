import { describe, expect, it, vi } from 'vitest'

const { fed } = vi.hoisted(() => ({ fed: { rows: [] as unknown[], removed: [] as string[] } }))
vi.mock('../../../../apps/desktop/src/lib/searchIndexFeed', () => ({
  feedRows: async (rows: unknown[]) => { fed.rows.push(...rows) },
  feedRemoved: async (ids: string[]) => { fed.removed.push(...ids) },
  feedChats: async () => {},
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({}) }))
import { searchIndexRevisionListener } from '../../../../apps/desktop/src/store/searchIndexWiring'

const created = (message: Record<string, unknown>) => ({ revision: '1', event: 'message_created',
  payload: { chat_id: 'g', entity_id: message.id, message } })

describe('search index revision listener', () => {
  it('indexes a created row, and removes deleted, deleted-for-me and globally deleted messages', async () => {
    const visible = { id: 'a', chat_id: 'g', seq: 1 }
    await searchIndexRevisionListener('me')([
      created(visible),
      created({ id: 'b', chat_id: 'g', seq: 2, deleted_for_user_ids: ['me'] }),
      created({ id: 'c', chat_id: 'g', seq: 3, deleted_at: '2026-10-30T00:00:00Z' }),
      { revision: '2', event: 'message_deleted', payload: { chat_id: 'g', entity_id: 'd' } },
    ])
    expect(fed.rows).toEqual([visible])
    expect(fed.removed).toEqual(['b', 'c', 'd'])
  })

  it('fails loudly on a malformed payload so the coordinator retries it', async () => {
    await expect(searchIndexRevisionListener('me')([{ revision: '3', event: 'message_deleted', payload: { chat_id: 'g' } }]))
      .rejects.toThrow(/entity_id/)
  })
})
