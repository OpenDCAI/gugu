import { afterEach, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ImMessageBatch, ImMessageWrite } from '../../../../apps/desktop/src/session/shared/core/im-messages'
import { message } from '../../../support/testHarness'

// Desktop: message bodies live in the session SQLite store (faked here at the IPC boundary).
const sqlite = vi.hoisted(() => ({ rows: new Map<string, MessageItem>() }))
vi.mock('../../../../apps/desktop/src/platform', async original => {
  const real = await original<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...real, platform: { ...real.platform, localMessages: 'sqlite' } }
})
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({ invoke: async (method: string, _account: string, ...args: unknown[]) => {
  if (method === 'imMessages.ingest') {
    const batch = args[0] as ImMessageBatch
    const accepted: ImMessageWrite[] = []
    for (const write of [...batch.writes, ...batch.revisions.flatMap(page => page.writes)]) {
      if (write.type === 'put') { sqlite.rows.set(write.message.id, write.message); accepted.push(write) }
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
afterEach(() => { for (const stop of stops.splice(0)) stop(); sqlite.rows.clear() })
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
