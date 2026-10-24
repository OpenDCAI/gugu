/**
 * R2 — 修订流不只靠 realtime 广播:定时对账 + 前台/可见/联网/唤醒 都会拉一次。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { imSelectors, openImRepository as openRawRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionRuntime, type AccountRevisionSource } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import {
  REVISION_RECONCILE_INTERVAL_MS,
  watchRevisionReconcile,
  type RevisionReconcileSignals,
} from '../../../../apps/desktop/src/lib/accountRevisionReconcile'

async function openImRepository(...args: Parameters<typeof openRawRepository>) {
  const repository = await openRawRepository(...args)
  if (!repository.snapshot().sync_state.some((row) => row.key === 'account-revision-cursor')) {
    await repository.transaction((transaction) => transaction.putSyncState('account-revision-cursor', { revision: '0' }))
  }
  return repository
}

function fakeSignals() {
  const listeners = { visible: new Set<() => void>(), online: new Set<() => void>(), foreground: new Set<() => void>() }
  const on = (set: Set<() => void>) => (listener: () => void) => { set.add(listener); return () => { set.delete(listener) } }
  const signals: RevisionReconcileSignals = {
    setInterval: (fn, ms) => setInterval(fn, ms),
    clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
    onVisible: on(listeners.visible),
    onOnline: on(listeners.online),
    onForeground: on(listeners.foreground),
  }
  const fire = (kind: keyof typeof listeners) => { for (const listener of listeners[kind]) listener() }
  const count = () => listeners.visible.size + listeners.online.size + listeners.foreground.size
  return { signals, fire, count }
}

afterEach(() => vi.useRealTimers())

describe('watchRevisionReconcile (R2)', () => {
  it('定时 + 可见/联网/前台(含系统唤醒)各触发一次 wake;退订后全部停止', async () => {
    vi.useFakeTimers()
    const wake = vi.fn()
    const { signals, fire, count } = fakeSignals()
    const stop = watchRevisionReconcile(wake, signals)

    await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS - 1)
    expect(wake).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(wake).toHaveBeenCalledTimes(1)
    fire('visible'); fire('online'); fire('foreground')
    expect(wake).toHaveBeenCalledTimes(4)

    stop()
    expect(count()).toBe(0)
    await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS * 3)
    expect(wake).toHaveBeenCalledTimes(4)
  })

  it('接进修订 runtime:广播丢了也会在对账节拍上拉到新 operation', async () => {
    vi.useFakeTimers()
    const repository = await openImRepository('account-a', { adapter: createMemoryLocalSyncDb() })
    const syncSince = vi.fn<AccountRevisionSource['syncSince']>()
      .mockResolvedValueOnce({ operations: [], hasMore: false })
      .mockResolvedValueOnce({ operations: [{ revision: '1', event: 'changed', payload: {} }], hasMore: false })
      .mockResolvedValue({ operations: [], hasMore: false })
    const { signals } = fakeSignals()
    const source: AccountRevisionSource = {
      syncSince,
      // 广播通道从不发 wake(模拟睡眠/断线期间丢了广播);只有对账触发器
      subscribeWake: (_accountId, onWake) => watchRevisionReconcile(() => onWake(null), signals),
    }
    const runtime = createAccountRevisionRuntime('account-a', repository, source)
    runtime.register('changed', (item, transaction) => transaction.putView('seen', item.revision))
    runtime.start()
    await runtime.whenIdle()
    expect(imSelectors.view('seen')(repository.snapshot())).toBeUndefined()

    await vi.advanceTimersByTimeAsync(REVISION_RECONCILE_INTERVAL_MS)
    await runtime.whenIdle()
    expect(imSelectors.view('seen')(repository.snapshot())).toBe('1')
    runtime.stop()
  })
})
