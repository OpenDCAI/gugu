import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { imSelectors, openImRepository as openRawRepository } from '../../../../apps/desktop/src/lib/imRepository'
import {
  ACCOUNT_REVISION_CURSOR_KEY,
  DRAIN_RETRY_DELAYS_MS,
  createAccountRevisionRuntime,
  parseRevisionPage,
  type AccountRevisionOperation,
  type AccountRevisionPage,
  type AccountRevisionSource,
} from '../../../../apps/desktop/src/lib/accountRevisionRuntime'

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

  afterEach(() => vi.useRealTimers())

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

  it('applies ordered pages atomically and leaves the cursor at the first failed revision', async () => {
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    syncSince
      .mockResolvedValueOnce(page([
        operation(1, 'chat_changed', { id: 'chat-1', name: 'Chat One' }),
        operation(2, 'message_changed', { id: 'message-1', chatId: 'chat-1' }),
      ], true))
      .mockResolvedValueOnce(page([operation(3, 'unknown_operation')]))

    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('chat_changed', (item, transaction) => {
      const payload = item.payload as { id: string; name: string }
      transaction.putView(`chat:${payload.id}`, payload)
    })
    runtime.register('message_changed', (item, transaction) => {
      const payload = item.payload as { id: string; chatId: string }
      transaction.putView(`message:${payload.id}`, payload)
    })

    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('unknown account revision event: unknown_operation')

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
      .mockResolvedValueOnce(page([operation(1, 'unknown')]))
      .mockResolvedValueOnce(page([operation(1, 'changed')]))
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))

    runtime.start()
    await expect(runtime.whenIdle()).rejects.toThrow('unknown account revision event: unknown')
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
