// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { IDBFactory, IDBObjectStore } from 'fake-indexeddb'
import { message } from '../../../support/testHarness'
import { openLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, ingestAccountMessage, readMessageWindow, replaceMessageWindow,
  type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { bindRepositoryMessageCache } from '../../../../apps/desktop/src/store/chatDiskWindow'

const opened: AccountImRepository[] = []
afterEach(() => { vi.restoreAllMocks(); for (const repository of opened.splice(0)) repository.close() })
async function open(account: string, factory: IDBFactory) {
  const repository = await openImRepository(account, { adapter: await openLocalSyncDb(factory) })
  opened.push(repository)
  return repository
}

it('atomically settles competing repositories; both commit bodies but only one wins the account/id claim', async () => {
  const factory = new IDBFactory()
  const a = await open('viewer', factory), b = await open('viewer', factory)
  const row = message({ id: 'arrival', chat_id: 'room', seq: 100 })
  const results = await Promise.all([a, b].map(repository => repository.transaction(tx => {
    const claim = ingestAccountMessage(repository, tx, row, '1')
    tx.putView('account-revision-operation:1', { revision: '1', event: 'message_created', payload: {} })
    tx.putSyncState('account-revision-cursor', { revision: '1' })
    return claim
  })))
  expect(results.filter(result => result.won)).toHaveLength(1)
  for (const repository of [a, b]) {
    expect(repository.snapshot().message.map(row => row.id)).toEqual(['arrival'])
    expect(readMessageWindow(repository, 'room')).toMatchObject({ sparse: true, maxSeq: 100 })
  }
  const reopened = await open('viewer', factory)
  const replay = await reopened.transaction(tx => ingestAccountMessage(reopened, tx, row, '2'))
  expect(replay.won).toBe(false)
  const other = await open('other-account', factory)
  expect((await other.transaction(tx => ingestAccountMessage(other, tx, row, '1'))).won).toBe(true)
  expect((await a.transaction(tx => ingestAccountMessage(a, tx, { ...row, id: 'different', seq: 101 }, '2'))).won).toBe(true)
})

it('rolls back message, claim, inbox and cursor when IDB aborts after inserting the claim', async () => {
  const factory = new IDBFactory()
  const repository = await open('viewer', factory)
  const row = message({ id: 'retry', chat_id: 'room', seq: 1 })
  const put = IDBObjectStore.prototype.put
  const interrupt = vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
    const request = put.call(this, value, key)
    if (this.name === 'view' && (value as { key?: string }).key === 'message-notification:retry') {
      request.addEventListener('success', () => this.transaction.abort())
    }
    return request
  })
  await expect(repository.transaction(tx => {
    ingestAccountMessage(repository, tx, row, '1')
    tx.putView('account-revision-operation:1', { revision: '1' })
    tx.putSyncState('account-revision-cursor', { revision: '1' })
  })).rejects.toThrow()
  interrupt.mockRestore()
  const reopened = await open('viewer', factory)
  expect(reopened.snapshot().message).toEqual([])
  expect(reopened.snapshot().view).toEqual([])
  expect(reopened.snapshot().sync_state).toEqual([])
  expect((await reopened.transaction(tx => ingestAccountMessage(reopened, tx, row, '1'))).won).toBe(true)
})

it('keeps an arrival when an older window finishes and does not certify a sparse range', async () => {
  const repository = await open('viewer', new IDBFactory())
  const row = message({ id: 'newest', chat_id: 'room', seq: 100 })
  await repository.transaction(tx => ingestAccountMessage(repository, tx, row, '1'))
  await replaceMessageWindow(repository, 'room', [message({ id: 'old', chat_id: 'room', seq: 1 })], false)
  expect(readMessageWindow(repository, 'room')).toMatchObject({ sparse: true, oldestSeq: 1, maxSeq: 100 })
  expect(readMessageWindow(repository, 'room')!.messages.map(row => row.id)).toEqual(['old', 'newest'])
  // Rewriting a painted cache cannot upgrade unverified coverage. Nor can a
  // later arrival hidden inside that L1 write become the server fetch's tail.
  const painted = readMessageWindow(repository, 'room')!.messages
  await replaceMessageWindow(repository, 'room', painted, false, null)
  expect(readMessageWindow(repository, 'room')!.sparse).toBe(true)
  await replaceMessageWindow(repository, 'room', painted, false, 1)
  expect(readMessageWindow(repository, 'room')!.sparse).toBe(true)
})

it('lets two live account runtimes display the same IDB arrival while only the winning window notifies', async () => {
  const factory = new IDBFactory()
  const repositories = await Promise.all([open('viewer', factory), open('viewer', factory)])
  const row = message({ id: 'two-window-message', chat_id: 'room', seq: 1 })
  const notify = vi.fn(async () => {})
  let live = false
  const wakes: Array<(head?: string | null) => void> = []
  const caches = repositories.map(() => new ChatWindowCache('viewer'))
  const unbinds = repositories.map((repository, index) => bindRepositoryMessageCache(repository, caches[index]!))
  for (const repository of repositories) await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  const coordinators = repositories.map(repository => createAccountRevisionCoordinator('viewer', repository, {
    syncSince: async cursor => ({ operations: live && cursor === '0'
      ? [{ revision: '1', event: 'message_created', payload: { chat_id: 'room', entity_id: row.id, message: row } }] : [], hasMore: false }),
    subscribeWake: (_id, wake) => { wakes.push(wake); return () => {} },
  }, { recover: async () => { throw new Error('complete payload must not recover') }, notify }))
  try {
    for (const coordinator of coordinators) coordinator.start()
    await Promise.all(coordinators.map(coordinator => coordinator.whenIdle()))
    live = true
    for (const wake of wakes) wake('1')
    await Promise.all(coordinators.map(coordinator => coordinator.whenIdle()))
    expect(notify).toHaveBeenCalledTimes(1)
    for (const cache of caches) expect(cache.rows('room').map(row => row.id)).toEqual([row.id])
  } finally {
    for (const coordinator of coordinators) coordinator.stop()
    for (const unbind of unbinds) unbind()
  }
})
