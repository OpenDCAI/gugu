import { afterEach, expect, it, vi } from 'vitest'
import { message, deferred, chat } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository, readMessageWindow, replaceMessageWindow } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator, type AccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { AccountRevisionOperation } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { bindRepositoryMessageCache } from '../../../../apps/desktop/src/store/chatDiskWindow'

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); vi.useRealTimers() })
const row = (id: string, seq = 1) => message({ id, seq, chat_id: 'room', sender_user_id: 'peer', to_user_ids: ['viewer'] })
const arrival = (revision: string, id: string, body: unknown = row(id)): AccountRevisionOperation => ({
  revision, event: 'message_created', payload: { chat_id: 'room', entity_id: id, message: body },
})
const membership = (revision: string, left: boolean, userId = 'viewer'): AccountRevisionOperation => ({
  revision, event: 'chat_members_changed', payload: { chat_id: 'room', user_id: userId, kind: 'roster', tombstone: left },
})
async function rig(initial: AccountRevisionOperation[] = [], recover = vi.fn(async (_id: string) => null as ReturnType<typeof message> | null)) {
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  const operations = [...initial]
  let wake!: (head?: string | null) => void
  const notify = vi.fn(async (item: ReturnType<typeof message>) => {
    // Commit before notify: the claim is durable even when retention trimmed the body from this window.
    expect(repository.snapshot().view.some(row => row.key === `message-revision:${item.id}`)).toBe(true)
  })
  const coordinator: AccountRevisionCoordinator = createAccountRevisionCoordinator('viewer', repository, {
    syncSince: async cursor => ({ operations: operations.filter(op => BigInt(op.revision) > BigInt(cursor)), hasMore: false }),
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }, { recover, notify })
  stops.push(() => { coordinator.stop(); repository.close() })
  coordinator.start()
  await coordinator.whenIdle()
  return { repository, coordinator, notify, recover,
    send(...next: AccountRevisionOperation[]) { operations.push(...next); wake(next.at(-1)!.revision); return coordinator.whenIdle() },
  }
}

it('silently ingests baseline history, then notifies only new live ids even when an outbox/window row already exists', async () => {
  const r = await rig([arrival('1', 'baseline')])
  expect(r.repository.snapshot().message.map(row => row.id)).toEqual(['baseline'])
  expect(r.notify).not.toHaveBeenCalled()
  await r.send(arrival('2', 'baseline'))
  expect(r.notify).not.toHaveBeenCalled()
  await replaceMessageWindow(r.repository, 'room', [row('live', 2)])
  await r.send(arrival('3', 'live', row('live', 2)))
  expect(r.notify.mock.calls.map(([message]) => message.id)).toEqual(['live'])
})

it('keeps a missing payload in the existing inbox until recovery commits its body and claim', async () => {
  const body = deferred<ReturnType<typeof message> | null>()
  const r = await rig([], vi.fn(() => body.promise))
  const done = r.send(arrival('1', 'legacy', null))
  await vi.waitFor(() => expect(r.recover).toHaveBeenCalledWith('legacy'))
  expect(r.repository.snapshot().sync_state.find(row => row.key === 'account-revision-cursor')!.value).toEqual({ revision: '1' })
  expect(r.repository.snapshot().view.some(row => row.key === 'account-revision-operation:1')).toBe(true)
  expect(r.repository.snapshot().message).toEqual([])
  expect(r.notify).not.toHaveBeenCalled()
  body.resolve(row('legacy'))
  await done
  expect(r.notify).toHaveBeenCalledTimes(1)
  expect(r.repository.snapshot().view.some(row => row.key === 'account-revision-operation:1')).toBe(false)
})

it('recovers an older payload without recipient metadata instead of silently consuming its notification claim', async () => {
  const authoritative = row('old-payload')
  const r = await rig([], vi.fn(async () => authoritative))
  const { to_user_ids: _missing, ...oldPayload } = authoritative
  await r.send(arrival('1', authoritative.id, oldPayload))
  expect(r.recover).toHaveBeenCalledWith(authoritative.id)
  expect(r.notify).toHaveBeenCalledWith(authoritative)
})

it('isolates failed payload recovery from another consumer and retries it without a premature claim', async () => {
  vi.useFakeTimers()
  const recover = vi.fn(async () => row('legacy')).mockRejectedValueOnce(new Error('body unavailable'))
  const r = await rig([], recover)
  const unrelated = vi.fn()
  r.coordinator.subscribe('chat_changed', unrelated)
  await expect(r.send(arrival('1', 'legacy', null), { revision: '2', event: 'chat_changed', payload: { chat_id: 'room' } })).rejects.toThrow('body unavailable')
  expect(unrelated).toHaveBeenCalledTimes(1)
  expect(r.notify).not.toHaveBeenCalled()
  expect(r.repository.snapshot().view.some(row => row.key === 'message-revision:legacy')).toBe(false)
  await vi.advanceTimersByTimeAsync(1000)
  await r.coordinator.whenIdle()
  expect(r.notify).toHaveBeenCalledTimes(1)
  expect(unrelated).toHaveBeenCalledTimes(1)
})

it('does not notify or revive a deleted arrival when a stale window or create completes later', async () => {
  const r = await rig()
  const cache = new ChatWindowCache('viewer')
  stops.push(bindRepositoryMessageCache(r.repository, cache))
  await r.send(arrival('1', 'removed'), { revision: '2', event: 'message_deleted', payload: { chat_id: 'room', entity_id: 'removed' } },
    arrival('3', 'removed'))
  expect(r.notify).not.toHaveBeenCalled()
  await replaceMessageWindow(r.repository, 'room', [row('removed')])
  await r.send(arrival('4', 'removed'))
  expect(readMessageWindow(r.repository, 'room')!.messages).toEqual([])
  expect(readMessageWindow(r.repository, 'room')).toMatchObject({ oldestSeq: 0, maxSeq: 0 })
  expect(r.notify).not.toHaveBeenCalled()
  expect(cache.rows('room')).toEqual([])
})

it('authoritative recovery absence cannot materialize or notify an inaccessible message', async () => {
  const r = await rig()
  await r.send(arrival('1', 'inaccessible', null))
  expect(r.recover).toHaveBeenCalledWith('inaccessible')
  expect(r.repository.snapshot().message).toEqual([])
  expect(r.notify).not.toHaveBeenCalled()
})

it('does not retry an alert after a committed claim even when the notification outlet fails', async () => {
  const r = await rig()
  r.notify.mockRejectedValueOnce(new Error('notification transport unavailable'))
  await r.send(arrival('1', 'claimed'))
  await r.send(arrival('2', 'claimed'))
  r.coordinator.retryPending(); await r.coordinator.whenIdle()
  expect(r.notify).toHaveBeenCalledTimes(1)
  expect(r.repository.snapshot().message.map(row => row.id)).toEqual(['claimed'])
  await r.send(arrival('3', 'another'))
  expect(r.notify).toHaveBeenCalledTimes(2)
})

it('bounds a whole arrival batch and marks its unverified range sparse instead of treating max seq as coverage', async () => {
  const r = await rig()
  await r.send(...Array.from({ length: 121 }, (_, index) => arrival(String(index + 1), `m${index + 1}`, row(`m${index + 1}`, index + 50))))
  const window = readMessageWindow(r.repository, 'room')!
  expect(window.messages).toHaveLength(120)
  expect(window).toMatchObject({ sparse: true, oldestSeq: 51, maxSeq: 170 })
})

it('membership rejoin permits a new body and notification after the revoked interval', async () => {
  const r = await rig()
  await r.send(membership('1', true), membership('2', false))
  await r.repository.transaction(tx => tx.putChat('room', chat({ id: 'room' })))
  await r.send(arrival('3', 'after-rejoin'))
  expect(readMessageWindow(r.repository, 'room')!.messages.map(message => message.id)).toEqual(['after-rejoin'])
  expect(r.notify.mock.calls.map(([message]) => message.id)).toEqual(['after-rejoin'])
})

it('membership changes for another member do not revoke this account or suppress its messages', async () => {
  const r = await rig()
  await r.send(membership('1', true, 'peer'), arrival('2', 'still-authorized'))
  expect(r.repository.snapshot().message.map(message => message.id)).toEqual(['still-authorized'])
  expect(r.notify.mock.calls.map(([message]) => message.id)).toEqual(['still-authorized'])
})
