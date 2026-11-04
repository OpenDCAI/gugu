// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { subscribeChatLineRevisions, type ChatLine } from '../../../../apps/desktop/src/lib/accountRevisionListeners'
import type { AccountRevisionOperation, AccountRevisionPage } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { applyMessageWindowRevalidation, loadMessageOverlays } from '../../../../apps/desktop/src/lib/chatMessageRevalidation'
import { deriveReadReceipt } from '@gugu/core/shared/ui/messageState'
import { message } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
const db = vi.hoisted(() => ({ from: vi.fn(), refusalFailure: false }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: db }))

beforeEach(() => {
  db.refusalFailure = false
  db.from.mockReset().mockImplementation((table: string) => ({ select: () => ({ in: async () => ({
    data: table === 'message_agent_delivery_blocks'
      ? [{ message_id: 'refused', agent_user_id: 'archived', reason: 'agent_archived' }] : [],
    error: table === 'message_agent_delivery_blocks' && db.refusalFailure ? { message: 'lookup failed' } : null,
  }) }) }))
})

describe('archived-agent delivery revisions', () => {
  it.each([
    { arrival: 'same page', deviceFields: { device_id: 'gugu-agent:archived' } },
    { arrival: 'later page', deviceFields: {} },
    { arrival: 'same page', deviceFields: { device_id: 'physical-device' } },
    { arrival: 'read-back failure', deviceFields: { device_id: { legacy: true } } },
  ] as const)('applies a refusal and subsequent reads with $arrival and $deviceFields without a reply or reload', async ({ arrival, deviceFields }) => {
    if (arrival === 'read-back failure') { vi.useFakeTimers(); db.refusalFailure = true }
    const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
    await repository.transaction((tx) => tx.putSyncState('account-revision-cursor', { revision: '0' }))
    const cache = new ChatWindowCache('viewer')
    cache.view('chat-1')
    cache.set('chat-1', [
      message({ id: 'refused', chat_id: 'chat-1', seq: 1, to_user_ids: ['archived', 'active'], is_mine: true, delivered: false, readers: [] }),
      message({ id: 'read', chat_id: 'chat-1', seq: 2, to_user_ids: ['active'], is_mine: true, delivered: false, readers: [] }),
    ])
    const revalidate = vi.fn(async (chatId: string, throwOnError: boolean) => {
      expect(throwOnError).toBe(true)
      const ids = cache.rows(chatId).map((row) => row.id)
      const overlays = await loadMessageOverlays(ids, 'viewer')
      cache.update(chatId, (rows) => applyMessageWindowRevalidation(rows, new Set(ids), {
        overlays, mutations: new Map(), presentIds: new Set(ids),
      }))
    })
    const line: ChatLine = {
      userId: 'viewer', chatId: () => 'chat-1', maxSeqOf: () => 2, getMessageSnapshotEpoch: () => 0,
      applyMessagesSnapshot: vi.fn(), healMessageGap: vi.fn(), revalidateWindowOverlays: revalidate,
      setMessagesAndCache: (update) => cache.update('chat-1', update),
      persistWindowToLocalSync: vi.fn(), setThreadMessages: vi.fn(),
      memberReadSeqsChatRef: { current: 'chat-1' }, setMemberReadSeqs: vi.fn(), readMemberReadSeqs: () => ({}),
    }
    const blocked = (revision: string): AccountRevisionOperation => ({ revision, event: 'delivery_changed', payload: {
      chat_id: 'chat-1', entity_id: 'refused', ...deviceFields,
      // broadcast_to_chat_member_user_events persists only these receipt fields; sync_since adds tombstone.
      status: 'blocked', tombstone: false,
    } })
    const read: AccountRevisionOperation = { revision: '2', event: 'delivery_changed', payload: {
      chat_id: 'chat-1', entity_id: 'read', device_id: 'gugu-agent:active', status: 'read', tombstone: false,
    } }
    const syncSince = vi.fn<() => Promise<AccountRevisionPage>>()
      .mockResolvedValueOnce({ operations: arrival === 'later page' ? [blocked('1')] : [blocked('1'), read], hasMore: false })
      .mockResolvedValue({ operations: [], hasMore: false })
    let wake: (head: string) => void = () => {}
    const coordinator = createAccountRevisionCoordinator('viewer', repository, {
      syncSince, subscribeWake: (_account, onWake) => { wake = onWake; return () => {} },
    })
    const off = subscribeChatLineRevisions(coordinator.subscribe, line)
    coordinator.start()
    try {
      // Continue to the next page even on the broken parent: the poison revision stays in its inbox.
      const firstError = await coordinator.whenIdle().catch((error: unknown) => error)
      if (arrival === 'read-back failure') {
        expect(firstError).toEqual(new Error('Message refusal status is unavailable: lookup failed'))
        expect(repository.snapshot().view).toHaveLength(2)
        db.refusalFailure = false
        await vi.advanceTimersByTimeAsync(1000)
        await coordinator.whenIdle()
      } else expect(firstError).toBeUndefined()
      syncSince.mockResolvedValueOnce({ operations: arrival === 'later page' ? [read, blocked('3')] : [blocked('3')], hasMore: false })
      wake('3')
      const nextError = await coordinator.whenIdle().catch((error: unknown) => error)
      expect(nextError).toBeUndefined()
      const [refused, received] = cache.rows('chat-1')
      expect(refused).toMatchObject({ delivered: false, delivery_status: null, readers: [],
        delivery_blocks: [{ agent_user_id: 'archived', reason: 'agent_archived' }] })
      expect(received).toMatchObject({ delivered: true, readers: ['active'] })
      expect(deriveReadReceipt(refused!, { archived: 0 })).toMatchObject({ readCount: 0 })
      expect(deriveReadReceipt(received!, { active: 0 }, { messageReaders: { read: new Set(received!.readers) } }))
        .toMatchObject({ readCount: 1 })
      expect(repository.snapshot().view).toEqual([])
      expect(revalidate).toHaveBeenCalledWith('chat-1', true)
      expect(db.from).toHaveBeenCalledWith('message_agent_delivery_blocks')
      syncSince.mockResolvedValueOnce({ operations: [{ ...read, revision: '4', payload: { ...read.payload as object, entity_id: 'refused' } }], hasMore: false })
      wake('4')
      await coordinator.whenIdle()
      const mixed = cache.rows('chat-1')[0]!
      expect(mixed).toMatchObject({ readers: ['active'], delivery_blocks: [{ agent_user_id: 'archived', reason: 'agent_archived' }] })
      expect(deriveReadReceipt(mixed, { archived: 0, active: 0 }, { messageReaders: { refused: new Set(mixed.readers) } }))
        .toMatchObject({ readCount: 1, totalRecipients: 2, readerIds: ['active'] })
    } finally {
      off()
      coordinator.stop()
      repository.close()
      vi.useRealTimers()
    }
  })
})
