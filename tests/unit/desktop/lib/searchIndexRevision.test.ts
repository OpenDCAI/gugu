import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import type { AccountRevisionSource } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'

const { fed, writeRows } = vi.hoisted(() => {
  const fed = { rows: [] as unknown[], removed: [] as string[] }
  return { fed, writeRows: vi.fn(async (rows: unknown[]) => { fed.rows.push(...rows) }) }
})
vi.mock('../../../../apps/desktop/src/lib/searchIndexFeed', () => ({
  feedRows: writeRows,
  feedRemoved: async (ids: string[]) => { fed.removed.push(...ids) },
  feedChats: async () => {},
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({}) }))
import { searchIndexRevisionListener } from '../../../../apps/desktop/src/store/searchIndexWiring'

const created = (message: Record<string, unknown>) => ({ revision: '1', event: 'message_created',
  payload: { chat_id: 'g', entity_id: message.id, message } })

beforeEach(() => { fed.rows.length = 0; fed.removed.length = 0; writeRows.mockClear() })
afterEach(() => vi.useRealTimers())

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

  it('keeps a failed search apply pending and retries that listener through the real coordinator', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('me', { adapter: createMemoryLocalSyncDb() })
    await repository.transaction((transaction) => transaction.putSyncState('account-revision-cursor', { revision: '0' }))
    const visible = { id: 'retry-message', chat_id: 'g', seq: 1 }
    const source: AccountRevisionSource = {
      syncSince: vi.fn().mockResolvedValueOnce({ operations: [created(visible)], hasMore: false })
        .mockResolvedValue({ operations: [], hasMore: false }),
      subscribeWake: () => () => {},
    }
    writeRows.mockRejectedValueOnce(new Error('Search disk write failed'))
    const coordinator = createAccountRevisionCoordinator('me', repository, source)
    coordinator.subscribe(['message_created', 'message_deleted'], searchIndexRevisionListener('me'))
    try {
      coordinator.start()
      await expect(coordinator.whenIdle()).rejects.toThrow('Search disk write failed')
      expect(repository.snapshot().view).toHaveLength(1)
      expect(fed.rows).toEqual([])
      await vi.advanceTimersByTimeAsync(1000)
      await coordinator.whenIdle()
      expect(writeRows).toHaveBeenCalledTimes(2)
      expect(fed.rows).toEqual([visible])
      expect(repository.snapshot().view).toEqual([])
    } finally { coordinator.stop() }
  })
})
