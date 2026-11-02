import { afterEach, expect, it, vi } from 'vitest'
import 'fake-indexeddb/auto'
import { IDBFactory, forceCloseDatabase } from 'fake-indexeddb'
import { createIndexedDbHandle } from '../../../../apps/desktop/src/lib/indexedDbHandle'
import { openLocalSyncDb, type LocalImDbAdapter } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openSessionInputStorage, SessionInputOutbox, type SessionInput } from '../../../../apps/desktop/src/lib/sessionInputOutbox'
import { getAgentWatchStore, resetAgentWatchStore } from '../../../../apps/desktop/src/session/shared/remote-sessions/local-store'
import { createIndexedDbBacklog } from '../../../../apps/desktop/src/mobile/assistant/phoneVoiceBacklog'

const forceClose = forceCloseDatabase as unknown as (db: IDBDatabase) => void
const handles: IDBDatabase[] = []
const adapters: LocalImDbAdapter[] = []
async function forceCloseAndWait(db: IDBDatabase) {
  const closed = new Promise<void>(resolve => db.addEventListener('close', () => resolve(), { once: true }))
  forceClose(db)
  await closed
}
afterEach(() => {
  for (const adapter of adapters.splice(0)) adapter.close()
  resetAgentWatchStore()
  for (const db of handles.splice(0)) db.close()
  vi.restoreAllMocks()
})

function trackedFactory() {
  const factory = new IDBFactory()
  const databases: IDBDatabase[] = []
  const open = factory.open.bind(factory)
  vi.spyOn(factory, 'open').mockImplementation((...args) => {
    const request = open(...args)
    request.addEventListener('success', () => {
      databases.push(request.result)
      handles.push(request.result)
    })
    return request
  })
  return { factory, databases }
}

it('invalidates a forced-close handle, coalesces the next opens, and keeps IM data', async () => {
  const tracked = trackedFactory()
  const adapter = await openLocalSyncDb(tracked.factory)
  adapters.push(adapter)
  await adapter.commit([{ type: 'put', store: 'view', value: { accountId: 'owner', key: 'before', value: 'saved' } }])
  await forceCloseAndWait(tracked.databases[0]!)
  await Promise.all(['management', 'ordinary'].map(key => adapter.commit([
    { type: 'put', store: 'view', value: { accountId: 'owner', key, value: 'after close' } },
  ])))
  const rows = (await adapter.loadAccount('owner')).view
  expect(rows).toEqual(expect.arrayContaining([
    { accountId: 'owner', key: 'before', value: 'saved' },
    { accountId: 'owner', key: 'management', value: 'after close' },
    { accountId: 'owner', key: 'ordinary', value: 'after close' },
  ]))
  expect(tracked.databases).toHaveLength(2)
})

it('enqueues and sends one input per session after forced close without losing already queued inputs', async () => {
  const tracked = trackedFactory()
  const storage = await openSessionInputStorage(tracked.factory)
  const deliver = vi.fn(async (_input: SessionInput) => {})
  const queue = new SessionInputOutbox('owner', storage, deliver, () => true)
  const pending = await queue.enqueue({ deviceId: null, sessionId: 'management', text: 'before close' })
  await forceCloseAndWait(tracked.databases[0]!)
  const next = await queue.enqueue({ deviceId: null, sessionId: 'ordinary', text: 'after close' })
  await queue.flush()
  expect(deliver.mock.calls.map(([input]) => input)).toEqual([pending, next])
  expect(await queue.list()).toEqual([])
  expect(tracked.databases).toHaveLength(2)
})

it('keeps independent main-window and quick-window owners usable after both are forced closed', async () => {
  const tracked = trackedFactory()
  const main = await openSessionInputStorage(tracked.factory)
  const quick = await openSessionInputStorage(tracked.factory)
  for (const db of [...tracked.databases]) await forceCloseAndWait(db)
  const input = { id: 'one', accountId: 'owner', deviceId: null, sessionId: 'management', text: 'hello', createdAt: 1 }
  await main.put(input)
  expect(await quick.list('owner')).toEqual([input])
  expect(tracked.databases).toHaveLength(4)
})

it.each(['im', 'input'] as const)('propagates an interrupted %s write without replay and permits a later write', async kind => {
  const tracked = trackedFactory()
  const adapter = await openLocalSyncDb(tracked.factory)
  adapters.push(adapter)
  const storage = await openSessionInputStorage(tracked.factory)
  const db = tracked.databases[kind === 'im' ? 0 : 1]!
  const closed = new Promise<void>(resolve => db.addEventListener('close', () => resolve(), { once: true }))
  const transaction = db.transaction.bind(db)
  const makeTransaction = vi.spyOn(db, 'transaction').mockImplementation((...args) => {
    const tx = transaction(...args)
    // Interrupt the native transaction after its requests have been enqueued.
    queueMicrotask(() => { tx.abort(); forceClose(db) })
    return tx
  })
  const write = kind === 'im'
    ? () => adapter.commit([{ type: 'put', store: 'view', value: { accountId: 'owner', key: 'draft', value: 'hello' } }])
    : () => storage.put({ id: 'input', accountId: 'owner', deviceId: null, sessionId: 'management', text: 'hello', createdAt: 1 })
  await expect(write()).rejects.toBeDefined()
  expect(makeTransaction).toHaveBeenCalledTimes(1)
  expect(tracked.databases).toHaveLength(2)
  await closed
  await write()
  expect(tracked.databases).toHaveLength(3)
})

it('does not reopen an explicitly disposed IM adapter', async () => {
  const tracked = trackedFactory()
  const adapter = await openLocalSyncDb(tracked.factory)
  adapter.close()
  await expect(adapter.loadAccount('owner')).rejects.toThrow('closed by its owner')
  expect(tracked.databases).toHaveLength(1)
})

it('closes a late opening result when its owner was disposed', async () => {
  const tracked = trackedFactory()
  let opened!: (db: IDBDatabase) => void
  const open = vi.fn(() => new Promise<IDBDatabase>(resolve => { opened = resolve }))
  const handle = createIndexedDbHandle(open)
  const pending = handle.get()
  handle.close()
  const request = tracked.factory.open('late')
  const db = await new Promise<IDBDatabase>(resolve => { request.onsuccess = () => resolve(request.result) })
  const close = vi.spyOn(db, 'close')
  opened(db)
  await expect(pending).rejects.toThrow('closed by its owner')
  expect(close).toHaveBeenCalledTimes(1)
  await expect(handle.get()).rejects.toThrow('closed by its owner')
  expect(open).toHaveBeenCalledTimes(1)
})

it('propagates open errors and only opens again for a new independent call', async () => {
  const error = new DOMException('disk unavailable', 'UnknownError')
  const open = vi.fn(async (): Promise<IDBDatabase> => { throw error })
  const handle = createIndexedDbHandle(open)
  await expect(handle.get()).rejects.toBe(error)
  expect(open).toHaveBeenCalledTimes(1)
  await expect(handle.get()).rejects.toBe(error)
  expect(open).toHaveBeenCalledTimes(2)
})

it('reopens the remote-session cache after forced close', async () => {
  const tracked = trackedFactory()
  const store = await getAgentWatchStore(tracked.factory)
  const row = { key: 'session', savedAt: 1, text: 'cached turn' }
  await store.put('timeline', row)
  await forceCloseAndWait(tracked.databases[0]!)
  expect(await store.read('timeline', row.key)).toEqual(row)
  await store.put('sessions', { ...row, savedAt: 2 })
  expect(await store.readAll('sessions')).toEqual([{ ...row, savedAt: 2 }])
  expect(tracked.databases).toHaveLength(2)
})

it('reopens the phone voice backlog without losing pending recordings', async () => {
  const tracked = trackedFactory()
  const backlog = createIndexedDbBacklog(tracked.factory)
  const job = { id: 'note', deviceId: 'phone', assistantId: 'agent', meta: {}, segments: [], recordingDone: true, created: false }
  await backlog.saveJob(job)
  await forceCloseAndWait(tracked.databases[0]!)
  expect(await backlog.list()).toEqual([job])
  await backlog.dropJob(job.id)
  expect(await backlog.list()).toEqual([])
  expect(tracked.databases).toHaveLength(2)
})
