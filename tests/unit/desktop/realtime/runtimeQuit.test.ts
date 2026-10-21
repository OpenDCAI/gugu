import { describe, expect, test, vi } from 'vitest'
import {
  createRuntimeBeforeQuitHandler,
  runShutdownPhase,
} from '../../../../apps/desktop/electron/runtime-quit'
async function flushAsync(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}
function deferredVoid() {
  let resolve!: () => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}
describe('runtime quit handler', () => {
  test('waits for the runtime host to stop before exiting with code zero', async () => {
    const stop = vi.fn(async () => undefined)
    const exit = vi.fn()
    const setQuitting = vi.fn()
    const event = { preventDefault: vi.fn() }
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => ({ stop }),
      setQuitting,
      exit,
      flushDurableStorage: async () => undefined,
    })
    handler(event)
    expect(setQuitting).toHaveBeenCalledWith(true)
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(stop).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()
    await flushAsync()
    expect(exit).toHaveBeenCalledWith(0)
  })
  test('also stops all owned resources before exiting', async () => {
    const stop = vi.fn(async () => undefined)
    const stopOwnedResources = vi.fn(async () => undefined)
    const exit = vi.fn()
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => ({ stop }),
      setQuitting: vi.fn(),
      exit,
      stopOwnedResources,
      flushDurableStorage: async () => undefined,
    })
    handler({ preventDefault: vi.fn() })
    await flushAsync()
    expect(stop).toHaveBeenCalledTimes(1)
    expect(stopOwnedResources).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
  test('waits for deferred Chromium storage flush before exiting', async () => {
    const flush = deferredVoid()
    const exit = vi.fn()
    const reportPhase = vi.fn()
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => null,
      setQuitting: vi.fn(),
      exit,
      flushDurableStorage: () => flush.promise,
      reportPhase,
    })
    handler({ preventDefault: vi.fn() })
    expect(exit).not.toHaveBeenCalled()
    expect(reportPhase).toHaveBeenCalledWith({ phase: 'chromium-storage', state: 'started', elapsedMs: 0 })
    flush.resolve()
    await flushAsync()
    expect(exit).toHaveBeenCalledWith(0)
    expect(reportPhase).toHaveBeenCalledWith(expect.objectContaining({ phase: 'chromium-storage', state: 'completed' }))
  })
  test('exits nonzero when deferred Chromium storage flush rejects', async () => {
    const flush = deferredVoid()
    const sibling = deferredVoid()
    const exit = vi.fn()
    const warn = vi.fn()
    const reportPhase = vi.fn()
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => null,
      setQuitting: vi.fn(),
      exit,
      warn,
      flushDurableStorage: () => flush.promise,
      stopOwnedResources: () => sibling.promise,
      reportPhase,
    })
    handler({ preventDefault: vi.fn() })
    flush.reject(new Error('storage flush failed'))
    await flushAsync()
    expect(exit).not.toHaveBeenCalled()
    sibling.resolve()
    await flushAsync()
    expect(exit).toHaveBeenCalledWith(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('storage flush failed'))
    expect(reportPhase).toHaveBeenCalledWith(expect.objectContaining({
      phase: 'chromium-storage',
      state: 'failed',
      error: 'storage flush failed',
    }))
  })
  test('reports named shutdown phases through terminal state', async () => {
    const events: Array<{ phase: string; state: string; elapsedMs: number }> = []
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => ({ stop: async () => undefined }),
      setQuitting: vi.fn(),
      exit: vi.fn(),
      stopOwnedResources: async () => undefined,
      flushDurableStorage: async () => undefined,
      reportPhase: (event) => events.push(event),
    })
    handler({ preventDefault: vi.fn() })
    await flushAsync()
    expect(events.slice(0, 3).map(({ phase, state }) => `${phase}:${state}`)).toEqual([
      'device-runtime-host:started',
      'owned-resources:started',
      'chromium-storage:started',
    ])
    expect(events.slice(3).map(({ phase, state }) => `${phase}:${state}`).sort()).toEqual([
      'chromium-storage:completed',
      'device-runtime-host:completed',
      'owned-resources:completed',
    ])
    expect(events.every(({ elapsedMs }) => elapsedMs >= 0)).toBe(true)
  })
  test('runs and settles a phase when its started reporter throws', async () => {
    const action = vi.fn(async () => undefined)
    const settle = vi.fn()
    await expect(runShutdownPhase(
      'probe',
      action,
      (event) => {
        if (event.state === 'started') throw new Error('started reporter failed')
      },
      settle,
    )).resolves.toBeUndefined()
    expect(action).toHaveBeenCalledOnce()
    expect(settle).toHaveBeenCalledWith({ status: 'fulfilled' })
  })
  test('reports final completion before a non-returning success terminal', async () => {
    const order: string[] = []
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => null,
      setQuitting: vi.fn(),
      exit: (code) => {
        order.push(`exit:${code}`)
        throw new Error('reallyExit does not return')
      },
      flushDurableStorage: async () => { order.push('action') },
      reportPhase: (event) => order.push(event.state),
    })
    handler({ preventDefault: vi.fn() })
    await flushAsync()
    expect(order).toEqual(['started', 'action', 'completed', 'exit:0'])
  })
  test('exits nonzero if owned resource cleanup rejects', async () => {
    const stop = vi.fn(async () => undefined)
    const stopOwnedResources = vi.fn(async () => { throw new Error('boom') })
    const exit = vi.fn()
    const warn = vi.fn()
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => ({ stop }),
      setQuitting: vi.fn(),
      exit,
      warn,
      stopOwnedResources,
      flushDurableStorage: async () => undefined,
    })
    handler({ preventDefault: vi.fn() })
    await flushAsync()
    expect(stopOwnedResources).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(1)
    expect(warn).toHaveBeenCalledTimes(1)
  })
  test('fails the named phase and exits when owned resource cleanup never settles', async () => {
    vi.useFakeTimers()
    try {
      const exit = vi.fn()
      const warn = vi.fn()
      const reportPhase = vi.fn()
      const handler = createRuntimeBeforeQuitHandler({
        getHost: () => null,
        setQuitting: vi.fn(),
        exit,
        warn,
        timeoutMs: 25,
        stopOwnedResources: () => new Promise<void>(() => {}),
        flushDurableStorage: async () => undefined,
        reportPhase,
      })
      handler({ preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(25)
      expect(exit).toHaveBeenCalledWith(1)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('owned-resources'))
      expect(reportPhase).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'owned-resources',
        state: 'failed',
        error: expect.stringContaining('timed out'),
      }))
    } finally {
      vi.useRealTimers()
    }
  })
  test('ignores a late phase completion after timeout settlement', async () => {
    vi.useFakeTimers()
    try {
      const cleanup = deferredVoid()
      const exit = vi.fn()
      const reportPhase = vi.fn()
      const handler = createRuntimeBeforeQuitHandler({
        getHost: () => null,
        setQuitting: vi.fn(),
        exit,
        timeoutMs: 25,
        stopOwnedResources: () => cleanup.promise,
        flushDurableStorage: async () => undefined,
        reportPhase,
      })
      handler({ preventDefault: vi.fn() })
      await vi.advanceTimersByTimeAsync(25)
      cleanup.resolve()
      await Promise.resolve()
      expect(exit).toHaveBeenCalledOnce()
      expect(reportPhase.mock.calls.filter(([event]) => event.phase === 'owned-resources'))
        .toHaveLength(2)
      expect(reportPhase).toHaveBeenCalledWith(expect.objectContaining({
        phase: 'owned-resources',
        state: 'failed',
      }))
      expect(reportPhase).not.toHaveBeenCalledWith(expect.objectContaining({
        phase: 'owned-resources',
        state: 'completed',
      }))
    } finally {
      vi.useRealTimers()
    }
  })
  test('stops owned resources even when the runtime host was never created', async () => {
    const stopOwnedResources = vi.fn(async () => undefined)
    const exit = vi.fn()
    const event = { preventDefault: vi.fn() }
    const handler = createRuntimeBeforeQuitHandler({
      getHost: () => null,
      setQuitting: vi.fn(),
      exit,
      stopOwnedResources,
      flushDurableStorage: async () => undefined,
    })
    handler(event)
    await flushAsync()
    expect(event.preventDefault).toHaveBeenCalledTimes(1)
    expect(stopOwnedResources).toHaveBeenCalledTimes(1)
    expect(exit).toHaveBeenCalledWith(0)
  })
})
