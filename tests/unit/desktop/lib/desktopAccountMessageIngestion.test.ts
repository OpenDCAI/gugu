import { afterEach, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ImMessageBatch, ImMessageWrite } from '../../../../apps/desktop/src/session/shared/core/im-messages'
import { message } from '../../../support/testHarness'

// Desktop: message bodies live in the session SQLite store (faked here at the IPC boundary).
const sqlite = vi.hoisted(() => ({ rows: new Map<string, MessageItem>(), claimed: new Set<string>() }))
vi.mock('../../../../apps/desktop/src/platform', async original => {
  const real = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...real, platform: { ...real.platform, localMessages: 'sqlite' } }
})
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: async (method: string, _account: string, ...args: unknown[]) => {
  if (method === 'imMessages.ingest') {
    const batch = args[0] as ImMessageBatch
    const accepted: ImMessageWrite[] = []
    const fromPages = new Set(batch.revisions.flatMap(page => page.writes))
    for (const write of [...batch.writes, ...batch.revisions.flatMap(page => page.writes)]) {
      if (write.type === 'put') {
        // Like the store: the first revision that delivers a message claims it, even after a page fetch stored it.
        const claims = fromPages.has(write) && !sqlite.claimed.has(write.message.id)
        if (claims) sqlite.claimed.add(write.message.id)
        sqlite.rows.set(write.message.id, write.message)
        accepted.push(claims ? { ...write, claimed: true } : write)
      }
      if (write.type === 'delete') { sqlite.rows.delete(write.id); accepted.push(write) }
    }
    return accepted
  }
  if (method === 'imMessages.windows') return [...sqlite.rows.values()].filter(row => (args[0] as string[]).includes(row.chat_id))
  if (method === 'imMessages.throughRevision') return null
  throw new Error(`unexpected ${method}`)
} }) }))

const { createMemoryLocalSyncDb } = await import('../../../../apps/desktop/src/lib/localSyncDb')
const { openImRepository, ackOutboxRecord } = await import('../../../../apps/desktop/src/lib/imRepository')
const { createAccountRevisionCoordinator } = await import('../../../../apps/desktop/src/lib/accountRevisionCoordinator')
const { ChatWindowCache } = await import('../../../../apps/desktop/src/store/chatWindowCache')
const { bindRepositoryMessageCache } = await import('../../../../apps/desktop/src/store/chatDiskWindow')

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); sqlite.rows.clear(); sqlite.claimed.clear() })
const row = (id: string, seq = 1) => message({ id, seq, chat_id: 'room', sender_user_id: 'peer', to_user_ids: ['viewer'] })
const arrival = (revision: string, id: string, seq = 1) => ({
  revision, event: 'message_created', payload: { chat_id: 'room', entity_id: id, message: row(id, seq) },
})

async function rig() {
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  const cache = new ChatWindowCache('viewer')
  bindRepositoryMessageCache(repository, cache)
  const operations: { revision: string; event: string; payload: unknown }[] = []
  let wake!: (head?: string | null) => void
  const notify = vi.fn(async (_message: MessageItem) => {})
  const coordinator = createAccountRevisionCoordinator('viewer', repository, {
    syncSince: async cursor => ({ operations: operations.filter(op => BigInt(op.revision) > BigInt(cursor)), hasMore: false }),
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }, { recover: async () => null, notify })
  stops.push(() => { coordinator.stop(); repository.close() })
  coordinator.start()
  await coordinator.whenIdle()
  return { repository, cache, notify,
    send(...next: typeof operations) { operations.push(...next); wake(next.at(-1)!.revision); return coordinator.whenIdle() } }
}

it('commits live desktop arrivals only to SQLite, feeds the unopened conversation and notifies once', async () => {
  const r = await rig()
  await r.send(arrival('1', 'live', 7))
  expect([...sqlite.rows.keys()]).toEqual(['live'])
  expect(r.repository.snapshot().message).toEqual([])
  expect(r.repository.snapshot().view.some(view => view.key === 'message-window:room')).toBe(false)
  expect(r.cache.get('room')?.map(item => item.id)).toEqual(['live'])
  expect(r.notify.mock.calls.map(([item]) => item.id)).toEqual(['live'])
  await r.send(arrival('2', 'live', 7))
  expect(r.notify).toHaveBeenCalledTimes(1)
})

it('keeps no per-message claim rows in the renderer: the store reports first arrivals', async () => {
  const r = await rig()
  await r.send(...Array.from({ length: 30 }, (_, index) => arrival(String(index + 1), `m${index}`, index + 1)))
  expect(r.notify).toHaveBeenCalledTimes(30)
  expect(r.repository.snapshot().view.filter(view => view.key.startsWith('message-revision:'))).toEqual([])
  await r.send(arrival('31', 'm0', 1))
  expect(r.notify).toHaveBeenCalledTimes(30)
})

it('still claims a live arrival whose body a conversation page fetch stored first', async () => {
  // An open conversation that is not on screen (another conversation in front, window minimised) can fetch the
  // message before the account feed delivers it. That fetch is not the person seeing it: the feed arrival still claims.
  const r = await rig()
  sqlite.rows.set('fetched-first', row('fetched-first'))
  await r.send(arrival('1', 'fetched-first'))
  expect(r.notify).toHaveBeenCalledTimes(1)
  expect(r.notify.mock.calls[0]![0].id).toBe('fetched-first')
})

it('drops claim rows written by earlier desktop builds when the account opens', async () => {
  const adapter = createMemoryLocalSyncDb()
  await adapter.commit([{ type: 'put', store: 'view', value: { accountId: 'viewer', key: 'message-revision:old', value: { revision: '1' } } },
    { type: 'put', store: 'view', value: { accountId: 'viewer', key: 'kept', value: 1 } }])
  const repository = await openImRepository('viewer', { adapter })
  stops.push(() => repository.close())
  expect(repository.snapshot().view.map(view => view.key)).toEqual(['kept'])
})

it('does not notify a desktop arrival deleted later in the same revision page', async () => {
  const r = await rig()
  await r.send(arrival('1', 'removed'), { revision: '2', event: 'message_deleted', payload: { chat_id: 'room', entity_id: 'removed' } })
  expect(r.notify).not.toHaveBeenCalled()
  expect(sqlite.rows.size).toBe(0)
})

it('acknowledges a sent desktop message into SQLite without an IndexedDB body', async () => {
  const r = await rig()
  const sent = row('sent', 3)
  await ackOutboxRecord(r.repository, 'sent', sent)
  expect(sqlite.rows.get('sent')).toEqual(sent)
  expect(r.repository.snapshot().message).toEqual([])
})
