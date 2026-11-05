import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { imSelectors, openImRepository as openRawRepository, type ImRepositoryTransaction } from '../../../../apps/desktop/src/lib/imRepository'
import { readMessageCreatedRevision } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { createAccountCatchupPriority } from '../../../../apps/desktop/src/lib/accountCatchupPriority'
import {
  ACCOUNT_REVISION_CURSOR_KEY,
  DRAIN_RETRY_DELAYS_MS,
  createAccountRevisionRuntime,
  parseRevisionPage,
  type AccountRevisionOperation,
  type AccountRevisionPage,
  type AccountRevisionSource,
} from '../../../../apps/desktop/src/lib/accountRevisionRuntime'

const ACCOUNT_REVISION_SKIPPED_KEY = 'account-revision-skipped'

async function openImRepository(...args: Parameters<typeof openRawRepository>) {
  const repository = await openRawRepository(...args)
  if (!repository.snapshot().sync_state.some((row) => row.key === 'account-revision-cursor')) {
    await repository.transaction((transaction) => transaction.putSyncState('account-revision-cursor', { revision: '0' }))
  }
  return repository
}

function operation(revision: number | string, event: string, payload: unknown = {}): AccountRevisionOperation {
  return { revision: String(revision), event, payload }
}

function page(operations: AccountRevisionOperation[], hasMore = false): AccountRevisionPage {
  return { operations, hasMore }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('AccountRevisionRuntime', () => {
  let wake: ((head?: string | null) => void) | null
  let unsubscribe: () => void
  let syncSince: ReturnType<typeof vi.fn<AccountRevisionSource['syncSince']>>
  let source: AccountRevisionSource

  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  beforeEach(() => {
    wake = null
    unsubscribe = vi.fn<() => void>()
    syncSince = vi.fn()
    source = {
      syncSince,
      subscribeWake: vi.fn((_accountId: string, listener: (head?: string | null) => void, onSubscribed: () => void): (() => void) => {
        wake = listener
        onSubscribed()
        return unsubscribe
      }),
    }
  })

  it('lets the foreground list/current conversation finish before fetching backlog', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const priority = createAccountCatchupPriority()
    const list = priority.begin(), conversation = priority.begin()
    syncSince.mockResolvedValueOnce(page([operation(1, 'changed')])).mockResolvedValue(page([]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source, 100, priority.scheduling)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))
    runtime.start()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(syncSince).not.toHaveBeenCalled()
    list()
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(syncSince).not.toHaveBeenCalled()
    conversation()
    await runtime.whenIdle()
    expect(imSelectors.view('seen')(repository.snapshot())).toBe('1')
    runtime.stop()
  })

  it('holds an already fetched page outside the repository while a foreground read opens', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const priority = createAccountCatchupPriority()
    const response = deferred<AccountRevisionPage>()
    syncSince.mockReturnValueOnce(response.promise).mockResolvedValue(page([]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source, 100, priority.scheduling)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))
    runtime.start()
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledOnce())
    const finish = priority.begin()
    response.resolve(page([operation(1, 'changed')]))
    await new Promise(resolve => setTimeout(resolve, 25))
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '0' })
    finish()
    await runtime.whenIdle()
    expect(imSelectors.view('seen')(repository.snapshot())).toBe('1')
    runtime.stop()
  })

  it('cancels a background turn on account stop without advancing its cursor', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const priority = createAccountCatchupPriority()
    const finish = priority.begin()
    const runtime = createAccountRevisionRuntime('account-a', repository, source, 100, priority.scheduling)
    runtime.start()
    const stopped = runtime.whenIdle()
    runtime.stop()
    await expect(stopped).rejects.toMatchObject({ name: 'AbortError' })
    finish()
    expect(syncSince).not.toHaveBeenCalled()
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '0' })
  })

  it('u1 skips unknown events, remembers their first revision and warns once per runtime', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const operations = [operation(1, 'known'), operation(2, 'future'), operation(3, 'known'), operation(4, 'future'), operation(5, 'future')]
    syncSince.mockImplementation(async (cursor, limit) => {
      const remaining = operations.filter((item) => BigInt(item.revision) > BigInt(cursor))
      return page(remaining.slice(0, limit), remaining.length > limit)
    })
    const runtime = createAccountRevisionRuntime('account-a', repository, source, 3)
    runtime.register('known', (item, transaction) => transaction.putView(`known:${item.revision}`, true))
    runtime.start()
    await runtime.whenIdle()
    expect(repository.snapshot().view.map((row) => row.key)).toEqual(['known:1', 'known:3'])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '5' })
    expect(imSelectors.syncState(ACCOUNT_REVISION_SKIPPED_KEY)(repository.snapshot())).toEqual({ future: '2' })
    expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('skipping unknown'), { accountId: 'account-a', event: 'future', revision: '2' })
    runtime.stop()
  })

  it('u2 still rejects a known malformed message and rolls back the page', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValue(page([
      operation(1, 'message_created', { chat_id: 'chat', entity_id: 'one', message: { id: 'one' } }),
      operation(2, 'message_created', { chat_id: 'chat', entity_id: 'two', message: { id: 'wrong' } }),
    ]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('message_created', (item, transaction) => transaction.putView(item.revision, readMessageCreatedRevision(item.payload)))
    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('message_created revision has malformed message')
    expect(repository.snapshot().view).toEqual([])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '0' })
    expect(imSelectors.syncState(ACCOUNT_REVISION_SKIPPED_KEY)(repository.snapshot())).toBeUndefined()
    runtime.stop()
  })

  it('u3 replays only newly recognized events across pages on upgrade and removes only their records', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const operations = [operation(1, 'known'), operation(2, 'future'), operation(3, 'known'), operation(4, 'later'), operation(5, 'future'), operation(6, 'known')]
    syncSince.mockImplementation(async (cursor, limit) => {
      const remaining = operations.filter((item) => BigInt(item.revision) > BigInt(cursor))
      return page(remaining.slice(0, limit), remaining.length > limit)
    })
    const old = createAccountRevisionRuntime('account-a', repository, source, 2)
    old.register('known', (item, transaction) => transaction.putView(`known:${item.revision}`, true))
    old.start()
    await old.whenIdle()
    old.stop()
    const known = vi.fn(), future = vi.fn((item: AccountRevisionOperation, transaction: ImRepositoryTransaction) => transaction.putView(`future:${item.revision}`, true))
    const upgraded = createAccountRevisionRuntime('account-a', repository, source, 2)
    upgraded.register('known', known)
    upgraded.register('future', future)
    upgraded.start()
    await upgraded.whenIdle()
    expect(future.mock.calls.map(([item]) => item.revision)).toEqual(['2', '5'])
    expect(known).not.toHaveBeenCalled()
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '6' })
    expect(imSelectors.syncState(ACCOUNT_REVISION_SKIPPED_KEY)(repository.snapshot())).toEqual({ later: '4' })
    expect(repository.snapshot().view.map((row) => row.key)).toEqual(['known:1', 'known:3', 'known:6', 'future:2', 'future:5'])
    upgraded.stop()
  })

  it('u4 commits skipped positions and the normal cursor atomically', async () => {
    const adapter = createMemoryLocalSyncDb()
    const repository = await openImRepository('account-a', { adapter })
    const commit = vi.spyOn(adapter, 'commit').mockRejectedValueOnce(new Error('commit interrupted'))
    syncSince.mockResolvedValue(page([operation(1, 'future')]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('commit interrupted')
    expect(commit.mock.calls[0]![0]).toEqual(expect.arrayContaining([
      { type: 'put', store: 'sync_state', value: { accountId: 'account-a', key: ACCOUNT_REVISION_SKIPPED_KEY, value: { future: '1' } } },
      { type: 'put', store: 'sync_state', value: { accountId: 'account-a', key: ACCOUNT_REVISION_CURSOR_KEY, value: { revision: '1' } } },
    ]))
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '0' })
    expect(imSelectors.syncState(ACCOUNT_REVISION_SKIPPED_KEY)(repository.snapshot())).toBeUndefined()
    expect((await adapter.loadAccount('account-a')).sync_state).toEqual([{ accountId: 'account-a', key: ACCOUNT_REVISION_CURSOR_KEY, value: { revision: '0' } }])
    runtime.stop()
  })

  it('u5 keeps IM writes available during replay and retains skipped positions until a failed replay is completed', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    await repository.transaction((transaction) => {
      transaction.putSyncState(ACCOUNT_REVISION_CURSOR_KEY, { revision: '4' })
      transaction.putSyncState(ACCOUNT_REVISION_SKIPPED_KEY, { future: '1' })
    })
    const operations = [operation(1, 'future'), operation(2, 'known'), operation(3, 'future'), operation(4, 'known')]
    const second = deferred<AccountRevisionPage>()
    syncSince.mockImplementation(async (cursor) => cursor === '0' ? page(operations.slice(0, 2), true) : cursor === '2' ? second.promise : page([]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source, 2)
    const future = (item: AccountRevisionOperation, transaction: ImRepositoryTransaction) => transaction.putView(`future:${item.revision}`, true)
    runtime.register('future', future)
    runtime.start()
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledWith('2', 2, expect.any(AbortSignal)))
    await repository.transaction((transaction) => transaction.putView('concurrent-write', true))
    expect(imSelectors.view('concurrent-write')(repository.snapshot())).toBe(true)
    expect(imSelectors.view('future:1')(repository.snapshot())).toBe(true)
    expect(imSelectors.syncState(ACCOUNT_REVISION_SKIPPED_KEY)(repository.snapshot())).toEqual({ future: '1' })
    second.reject(new Error('second replay page unavailable'))
    await expect(runtime.whenIdle()).rejects.toThrow('second replay page unavailable')
    runtime.stop()
    expect(imSelectors.syncState(ACCOUNT_REVISION_SKIPPED_KEY)(repository.snapshot())).toEqual({ future: '1' })
    syncSince.mockImplementation(async (cursor, limit) => {
      const remaining = operations.filter((item) => BigInt(item.revision) > BigInt(cursor))
      return page(remaining.slice(0, limit), remaining.length > limit)
    })
    const restarted = createAccountRevisionRuntime('account-a', repository, source, 2)
    const known = vi.fn()
    restarted.register('future', future)
    restarted.register('known', known)
    restarted.start()
    await restarted.whenIdle()
    expect(known).not.toHaveBeenCalled()
    expect(repository.snapshot().view.map((row) => row.key)).toEqual(['future:1', 'concurrent-write', 'future:3'])
    expect(imSelectors.syncState(ACCOUNT_REVISION_SKIPPED_KEY)(repository.snapshot())).toEqual({})
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '4' })
    restarted.stop()
  })

  it('requires a snapshot before a missing cursor can consume any journal page', async () => {
    const repository = await openRawRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('requires a snapshot')
    expect(syncSince).not.toHaveBeenCalled()
    runtime.stop()
  })

  it('applies ordered pages atomically and leaves the cursor at the first failed revision', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince
      .mockResolvedValueOnce(page([
        operation(1, 'chat_changed', { id: 'chat-1', name: 'Chat One' }),
        operation(2, 'message_changed', { id: 'message-1', chatId: 'chat-1' }),
      ], true))
      .mockResolvedValueOnce(page([operation(3, 'bad_operation')]))

    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('chat_changed', (item, transaction) => {
      const payload = item.payload as { id: string; name: string }
      transaction.putView(`chat:${payload.id}`, payload)
    })
    runtime.register('message_changed', (item, transaction) => {
      const payload = item.payload as { id: string; chatId: string }
      transaction.putView(`message:${payload.id}`, payload)
    })

    runtime.register('bad_operation', () => { throw new Error('invalid revision payload') })
    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('invalid revision payload')

    expect(repository.snapshot().view.map((row) => row.key)).toEqual(['chat:chat-1', 'message:message-1'])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '2' })
    expect(syncSince).toHaveBeenNthCalledWith(1, '0', 100, expect.any(AbortSignal))
    expect(syncSince).toHaveBeenNthCalledWith(2, '2', 100, expect.any(AbortSignal))
    runtime.stop()
  })

  it('coalesces concurrent wakes into one serial drain and resumes from the committed cursor', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const first = deferred<AccountRevisionPage>()
    syncSince
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(page([operation(1, 'changed')]))
      .mockResolvedValueOnce(page([]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))

    runtime.start()
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledTimes(1))
    wake?.()
    wake?.()
    first.resolve(page([]))
    await runtime.whenIdle()

    expect(syncSince.mock.calls.map((call) => call[0])).toEqual(['0', '0'])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '1' })
    runtime.stop()
  })

  it('accepts a later wake after a failed drain instead of poisoning the owner chain', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince
      .mockResolvedValueOnce(page([operation(1, 'changed', { malformed: true })]))
      .mockResolvedValueOnce(page([operation(1, 'changed')]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => {
      if ((item.payload as { malformed?: boolean }).malformed) throw new Error('invalid revision payload')
      transaction.putView('seen', item.revision)
    })

    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('invalid revision payload')
    runtime.wake()
    await runtime.whenIdle()

    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '1' })
    expect(imSelectors.view('seen')(repository.snapshot())).toBe('1')
    runtime.stop()
  })

  it('R1 drain 失败不等下一条 wake:按退避从游标重拉,成功后退避归零', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince
      .mockRejectedValueOnce(new Error('network down'))
      .mockRejectedValueOnce(new Error('still down'))
      .mockResolvedValueOnce(page([operation(1, 'changed')]))
      .mockResolvedValue(page([]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))

    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('network down')
    await vi.advanceTimersByTimeAsync(DRAIN_RETRY_DELAYS_MS[0] - 1)
    expect(syncSince).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(syncSince).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(DRAIN_RETRY_DELAYS_MS[1])
    await runtime.whenIdle()
    expect(syncSince.mock.calls.map((call) => call[0])).toEqual(['0', '0', '0'])
    expect(imSelectors.view('seen')(repository.snapshot())).toBe('1')
    // 成功后不再有排着的重试
    await vi.advanceTimersByTimeAsync(60_000)
    expect(syncSince).toHaveBeenCalledTimes(3)
    runtime.stop()
  })

  it('R1 页序号不连续 ⇒ 整页拒收、游标不动,退避后从游标整体重拉', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince
      .mockResolvedValueOnce(page([operation(1, 'changed'), operation(3, 'changed')]))
      .mockResolvedValueOnce(page([operation(1, 'changed'), operation(2, 'changed'), operation(3, 'changed')]))
      .mockResolvedValue(page([]))
    const seen: string[] = []
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item) => { seen.push(item.revision) })

    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('account revision sequence is invalid at 3; expected 2')
    expect(seen).toEqual([])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '0' })
    await vi.advanceTimersByTimeAsync(DRAIN_RETRY_DELAYS_MS[0])
    await runtime.whenIdle()
    expect(syncSince.mock.calls.map((call) => call[0])).toEqual(['0', '0'])
    expect(seen).toEqual(['1', '2', '3'])
    runtime.stop()
  })

  it('R1 stop 撤掉排着的重试', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockRejectedValue(new Error('down'))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('down')
    runtime.stop()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(syncSince).toHaveBeenCalledTimes(1)
  })

  it('keeps revisions exact beyond the JavaScript safe-integer boundary', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    await repository.transaction((transaction) => {
      transaction.putSyncState(ACCOUNT_REVISION_CURSOR_KEY, { revision: '9007199254740992' })
    })
    syncSince
      .mockResolvedValueOnce(page([operation('9007199254740993', 'changed')]))
      .mockResolvedValueOnce(page([]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))

    runtime.start()
    await runtime.whenIdle()

    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot()))
      .toEqual({ revision: '9007199254740993' })
    runtime.stop()
  })

  it('starts catch-up even when the realtime subscription never acknowledges', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    source.subscribeWake = vi.fn((_accountId: string, _listener: (head?: string | null) => void, _onSubscribed: () => void) => unsubscribe)
    syncSince.mockResolvedValue(page([]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)

    runtime.start()
    await runtime.whenIdle()

    expect(syncSince).toHaveBeenCalledWith('0', 100, expect.any(AbortSignal))
    runtime.stop()
  })

  it.each([
    ['gap', [operation(2, 'changed')]],
    ['duplicate', [operation(1, 'changed'), operation(1, 'changed')]],
    ['out of order', [operation(2, 'changed'), operation(1, 'changed')]],
  ])('rejects a revision %s without advancing the cursor', async (_name, operations) => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince.mockResolvedValue(page(operations))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView(`revision:${item.revision}`, true))

    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('account revision sequence')
    expect(repository.snapshot().view).toEqual([])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '0' })
    runtime.stop()
  })

  it('fences an in-flight page after stop and removes the exact wake owner', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const pending = deferred<AccountRevisionPage>()
    syncSince.mockReturnValue(pending.promise)
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))

    runtime.start()
    runtime.stop()
    pending.resolve(page([operation(1, 'changed')]))
    await runtime.whenIdle()

    expect(unsubscribe).toHaveBeenCalledTimes(1)
    expect(repository.snapshot().view).toEqual([])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '0' })
  })
  it('#5649 skips the trailing catch-up when the wake that arrived mid-drain is already covered', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const third = deferred<AccountRevisionPage>()
    syncSince
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([]))
      .mockReturnValueOnce(third.promise)
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))

    runtime.start()
    await runtime.whenIdle()
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledTimes(2)) // start = onSubscribed + 显式各一轮

    wake?.('1')
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledTimes(3))
    // 第三轮 drain 进行中又来两条 wake,head 分别是 2 和 3;这一页已经把 1..3 都带回来了
    wake?.('2')
    wake?.('3')
    third.resolve(page([operation(1, 'changed'), operation(2, 'changed'), operation(3, 'changed')]))
    await runtime.whenIdle()
    await Promise.resolve()

    expect(syncSince).toHaveBeenCalledTimes(3)
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '3' })
    runtime.stop()
  })

  it('#5649 still catches up after the drain when a mid-drain wake carried no head', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const third = deferred<AccountRevisionPage>()
    syncSince
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce(page([]))
      .mockReturnValueOnce(third.promise)
      .mockResolvedValueOnce(page([operation(3, 'changed')]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))

    runtime.start()
    await runtime.whenIdle()
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledTimes(2))

    wake?.('1')
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledTimes(3))
    wake?.('2')
    wake?.() // head 未知 ⇒ 无法判断是否已涵盖,必须再拉
    third.resolve(page([operation(1, 'changed'), operation(2, 'changed')]))
    await vi.waitFor(() => expect(syncSince).toHaveBeenCalledTimes(4))
    await runtime.whenIdle()

    expect(syncSince.mock.calls.map((call) => call[0])).toEqual(['0', '0', '0', '2'])
    expect(imSelectors.syncState(ACCOUNT_REVISION_CURSOR_KEY)(repository.snapshot())).toEqual({ revision: '3' })
    runtime.stop()
  })
})

describe('parseRevisionPage', () => {
  it('preserves decimal BIGINT revisions and rejects numeric transport coercion', () => {
    expect(parseRevisionPage({
      operations: [{ revision: '9007199254740993', event: 'changed', payload: {} }],
      has_more: false,
    }).operations[0]?.revision).toBe('9007199254740993')
    expect(() => parseRevisionPage({
      operations: [{ revision: 1, event: 'changed', payload: {} }],
      has_more: false,
    })).toThrow('malformed operation')
  })
})
