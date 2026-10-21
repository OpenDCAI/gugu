import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProcessMetricsResponder } from '../../../../apps/desktop/electron/process-metrics-responder'
import { RENDERER_METRICS_REPLY, RENDERER_METRICS_REQUEST } from '../../../../apps/desktop/src/session/shared/renderer-metrics'

function fixture() {
  const bus = new EventEmitter()
  const send = vi.fn()
  const ipc = Object.assign(bus, { send }) as unknown as Parameters<typeof installProcessMetricsResponder>[0]
  const current = {
    getHeapStatistics: vi.fn(() => ({ usedHeapSize: 5, totalHeapSize: 9 })),
    getBlinkMemoryInfo: vi.fn(() => ({ allocated: 2, total: 7 })),
    getProcessMemoryInfo: vi.fn(async () => ({ private: 11 })),
  }
  return { bus, send, ipc, current }
}

describe('preload process metrics responder', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('does not read or send anything until asked, then converts all KiB fields to bytes', async () => {
    const { bus, ipc, send, current } = fixture()
    const dispose = installProcessMetricsResponder(ipc, current, 'main-window')
    vi.advanceTimersByTime(60_000)
    bus.emit(RENDERER_METRICS_REQUEST, {}, { requestId: '' })
    expect(current.getHeapStatistics).not.toHaveBeenCalled()
    expect(current.getBlinkMemoryInfo).not.toHaveBeenCalled()
    expect(current.getProcessMemoryInfo).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
    const response = new Promise<unknown>((resolve) => send.mockImplementation((...args) => resolve(args)))
    bus.emit(RENDERER_METRICS_REQUEST, {}, { requestId: 'sample-1' })
    expect(await response).toEqual([RENDERER_METRICS_REPLY, { requestId: 'sample-1', source: 'main-window', v8: { usedBytes: 5120, totalBytes: 9216 }, oilpan: { allocatedBytes: 2048, totalBytes: 7168 }, privateBytes: 11264 }])
    expect(vi.getTimerCount()).toBe(0)
    dispose()
    expect(bus.listenerCount(RENDERER_METRICS_REQUEST)).toBe(0)
  })

  it('preserves available fields while explaining failed APIs instead of supplying zeroes', async () => {
    const { bus, ipc, send, current } = fixture()
    current.getHeapStatistics.mockImplementation(() => { throw new Error('heap unavailable') })
    current.getProcessMemoryInfo.mockRejectedValue(new Error('private unavailable'))
    installProcessMetricsResponder(ipc, current, 'main-window')
    const response = new Promise<unknown[]>((resolve) => send.mockImplementation((...args) => resolve(args)))
    bus.emit(RENDERER_METRICS_REQUEST, {}, { requestId: 'sample-1' })
    const [, value] = await response
    expect(value).toMatchObject({ oilpan: { allocatedBytes: 2048, totalBytes: 7168 }, unavailable: expect.stringMatching(/V8:.*heap unavailable.*private memory:.*private unavailable/) })
    expect(value).not.toHaveProperty('v8')
    expect(value).not.toHaveProperty('privateBytes')
  })

  it('does not install subframe responders', () => {
    const { bus, ipc, current } = fixture()
    installProcessMetricsResponder(ipc, { ...current, isMainFrame: false }, 'main-window')()
    expect(bus.listenerCount(RENDERER_METRICS_REQUEST)).toBe(0)
  })
})
