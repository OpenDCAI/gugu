import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { PERF_COUNTERS_REPLY, RENDERER_METRICS_REQUEST } from '../../../../apps/desktop/src/session/shared/renderer-metrics'

describe('source performance counters', () => {
  beforeEach(() => { vi.resetModules(); vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does no sampling or periodic work when imported, written, or read', async () => {
    const counters = await import('../../../../apps/desktop/src/lib/perfCounters')
    expect(counters.readPerfCounters()).toEqual({ imTransactions: 0, presenceBatches: 0, presenceIds: 0, contactsProviderRenders: 0 })
    counters.recordImTransaction()
    counters.recordPresenceBatch(200)
    counters.recordPresenceBatch(5)
    counters.recordContactsRender()
    const snapshot = counters.readPerfCounters()
    expect(snapshot).toEqual({ imTransactions: 1, presenceBatches: 2, presenceIds: 205, contactsProviderRenders: 1 })
    snapshot.presenceIds = 0
    vi.advanceTimersByTime(60_000)
    expect(counters.readPerfCounters().presenceIds).toBe(205)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('answers only valid main requests through the existing bridge, and disposes', async () => {
    const { installPerfCounterResponder } = await import('../../../../apps/desktop/src/lib/perfCounterResponder')
    const { recordImTransaction } = await import('../../../../apps/desktop/src/lib/perfCounters')
    const bus = new EventEmitter()
    const eventSend = vi.fn()
    const dispose = installPerfCounterResponder({
      eventOn: (channel, listener) => { bus.on(channel, listener); return () => { bus.off(channel, listener) } },
      eventSend,
    })
    recordImTransaction()
    vi.advanceTimersByTime(60_000)
    bus.emit(RENDERER_METRICS_REQUEST, null)
    expect(eventSend).not.toHaveBeenCalled()
    bus.emit(RENDERER_METRICS_REQUEST, { requestId: 'sample-1' })
    expect(eventSend).toHaveBeenCalledWith(PERF_COUNTERS_REPLY, { requestId: 'sample-1', counters: { imTransactions: 1, presenceBatches: 0, presenceIds: 0, contactsProviderRenders: 0 } })
    dispose()
    bus.emit(RENDERER_METRICS_REQUEST, { requestId: 'sample-2' })
    expect(eventSend).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
    expect(() => installPerfCounterResponder(undefined)()).not.toThrow()
  })
})
