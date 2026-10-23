import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb'
import { openLocalSyncDb, type LocalImDbAdapter, type LocalImDbOperation } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, type OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'
import { ACCOUNT_REVISION_CURSOR_KEY, createAccountRevisionRuntime } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { decodeAccountSnapshot, initializeAccountSync } from '../../../../apps/desktop/src/lib/accountSyncSnapshot'
import { message } from '../../../support/testHarness'

const { rpc } = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc }, identityDb: {}, dataClient: {} }))

const identity = { id: 'account-a', type: 'human', display_name: 'A', avatar: null, gugu_number: null, bio: null,
  owner_user_id: null, agent_public: null, desired_status: null, device_id: null, category: null,
  is_official: null, local_path: null, created_at: null, updated_at: null }
function serverSnapshot(revision = '422010') {
  return { account_id: 'account-a', revision, chats: [], memberships: [], identities: [identity],
    previews: [], unread: [], overrides: [], presence: {} }
}
const pending: OutboxRecord = { clientMessageId: 'unsent', chatId: 'chat-1', senderUserId: 'account-a',
  payload: { content: 'keep this input', contentType: 'text', toUserIds: null, replyToMessageId: null,
    threadRootId: null, isThreadRoot: false, isWhisper: false },
  state: 'pending', attempts: 0, lastError: null, enqueuedAt: '2026-10-23T00:00:00Z', updatedAt: '2026-10-23T00:00:00Z' }
let adapter: LocalImDbAdapter
beforeEach(async () => {
  vi.stubGlobal('IDBKeyRange', IDBKeyRange)
  adapter = await openLocalSyncDb(new IDBFactory())
  rpc.mockReset().mockReturnValue({ abortSignal: vi.fn().mockResolvedValue({ data: serverSnapshot(), error: null }) })
})
afterEach(() => { adapter.close(); vi.unstubAllGlobals() })

describe('account snapshot bootstrap and repair', () => {
  it('starts cold accounts at the snapshot head and validates the first following revision', async () => {
    const repository = await openImRepository('account-a', { adapter, initialize: initializeAccountSync })
    expect(repository.snapshot().sync_state[0]!.value).toEqual({ revision: '422010' })
    const syncSince = vi.fn().mockResolvedValue({ operations: [{ revision: '422011', event: 'changed', payload: {} }], hasMore: false })
    const runtime = createAccountRevisionRuntime('account-a', repository, { syncSince, subscribeWake: () => () => undefined })
    runtime.register('changed', (op, tx) => tx.putView('seen', op.revision))
    runtime.start()
    await runtime.whenIdle()
    runtime.stop()
    expect(syncSince).toHaveBeenCalledExactlyOnceWith('422010', 100, expect.any(AbortSignal))
    expect(repository.snapshot().view[0]!.value).toBe('422011')
    expect((await adapter.loadAccount('account-a')).sync_state[0]!.value).toEqual({ revision: '422011' })
  })

  it('discards a missing-stream cache and preserves unsent input atomically', async () => {
    const cached = await openImRepository('account-a', { adapter })
    await cached.transaction((tx) => {
      tx.putMessage(message({ id: 'cached-message', chat_id: 'chat-1', sender_user_id: 'account-a', seq: 1 }))
      tx.putOutbox(pending)
      tx.putSyncState(ACCOUNT_REVISION_CURSOR_KEY, { revision: '12' })
    })
    await adapter.commit([{ type: 'delete', store: 'stream', key: ['account-a', 'main:chat-1'] }])
    const repaired = await openImRepository('account-a', { adapter, initialize: initializeAccountSync })
    expect(repaired.snapshot().message).toEqual([])
    expect(repaired.snapshot().outbox[0]!.value).toEqual(pending)
    expect(repaired.snapshot().sync_state[0]!.value).toEqual({ revision: '422010' })
    const durable = await adapter.loadAccount('account-a')
    expect(durable.identity[0]!.id).toBe('account-a')
    expect(durable.outbox[0]!.value).toEqual(pending)
    expect(durable.sync_state[0]!.value).toEqual({ revision: '422010' })
  })

  it('rebuilds a malformed cursor, while a valid warm cursor performs no snapshot RPC', async () => {
    const cached = await openImRepository('account-a', { adapter })
    await cached.transaction((tx) => tx.putSyncState(ACCOUNT_REVISION_CURSOR_KEY, { revision: 'bad' }))
    await openImRepository('account-a', { adapter, initialize: initializeAccountSync })
    expect(rpc).toHaveBeenCalledTimes(1)
    await openImRepository('account-a', { adapter, initialize: initializeAccountSync })
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('aborts a replacement transaction midway and fully succeeds on the next retry', async () => {
    const cached = await openImRepository('account-a', { adapter })
    await cached.transaction((tx) => { tx.putOutbox(pending); tx.putIdentity({ ...identity, display_name: 'old' }) })
    let fail = true
    const failingAdapter: LocalImDbAdapter = { ...adapter, commit: async (operations) => {
      const next: LocalImDbOperation[] = [...operations]
      if (fail && operations.some((op) => op.type === 'clearAccount')) {
        fail = false
        next.push({ type: 'put', store: 'identity', value: { accountId: 'account-a' } })
      }
      return adapter.commit(next)
    } }
    await expect(openImRepository('account-a', { adapter: failingAdapter, initialize: initializeAccountSync })).rejects.toThrow()
    const beforeRetry = await adapter.loadAccount('account-a')
    expect(beforeRetry.sync_state).toEqual([])
    expect((beforeRetry.identity[0]!.value as { display_name: string }).display_name).toBe('old')
    expect(beforeRetry.outbox[0]!.value).toEqual(pending)
    await openImRepository('account-a', { adapter: failingAdapter, initialize: initializeAccountSync })
    const afterRetry = await adapter.loadAccount('account-a')
    expect(afterRetry.sync_state[0]!.value).toEqual({ revision: '422010' })
    expect(afterRetry.outbox[0]!.value).toEqual(pending)
    expect((afterRetry.identity[0]!.value as { display_name: string }).display_name).toBe('A')
  })

  it('surfaces invalid outbox and IO failures without clearing user input', async () => {
    await adapter.commit([{ type: 'put', store: 'outbox', value: { accountId: 'account-a', id: 'unsent', value: {} } }])
    await expect(openImRepository('account-a', { adapter, initialize: initializeAccountSync })).rejects.toThrow('invalid current outbox row')
    expect(rpc).not.toHaveBeenCalled()
    const commit = vi.fn()
    await expect(openImRepository('account-a', { adapter: { ...adapter, loadAccount: async () => { throw new Error('IO failed') }, commit }, initialize: initializeAccountSync })).rejects.toThrow('IO failed')
    expect(commit).not.toHaveBeenCalled()
  })

  it('does not commit a failed RPC, foreign account or incomplete snapshot', async () => {
    rpc.mockReturnValueOnce({ abortSignal: vi.fn().mockResolvedValue({ data: null, error: new Error('offline') }) })
    await expect(openImRepository('account-a', { adapter, initialize: initializeAccountSync })).rejects.toThrow('offline')
    expect((await adapter.loadAccount('account-a')).sync_state).toEqual([])
    expect(() => decodeAccountSnapshot(serverSnapshot(), 'account-b')).toThrow('account boundary')
    expect(() => decodeAccountSnapshot({ ...serverSnapshot(), identities: [] }, 'account-a')).toThrow('incomplete')
  })
})
