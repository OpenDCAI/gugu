import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PERF_COUNTERS_REPLY, RENDERER_METRICS_REPLY } from '../../../../apps/desktop/src/session/shared/renderer-metrics'

const mock = vi.hoisted(() => ({ bus: null as unknown as EventEmitter, all: vi.fn() }))
vi.mock('electron', () => ({
  ipcMain: {
    on: (channel: string, listener: (...args: unknown[]) => void) => mock.bus.on(channel, listener),
    removeListener: (channel: string, listener: (...args: unknown[]) => void) => mock.bus.removeListener(channel, listener),
  },
  webContents: { getAllWebContents: mock.all },
}))

function contents(id: number, pid: number, source: 'main' | 'app' | 'other' = 'app') {
  const result = Object.assign(new EventEmitter(), {
    id, pid, source, mainFrame: {}, dead: false,
    send: vi.fn(),
    isDestroyed: () => result.dead,
    getOSProcessId: () => result.pid,
    getURL: () => source === 'main' ? 'gugu-app://app/index.html' : 'https://example.test/',
    getType: () => source === 'app' ? 'webview' : 'window',
  })
  return result
}
type Contents = ReturnType<typeof contents>
function reply(wc: Contents, channel: string, value: object) {
  const requestId = (wc.send.mock.calls[0][1] as { requestId: string }).requestId
  mock.bus.emit(channel, { sender: wc, senderFrame: wc.mainFrame }, { requestId, source: wc.source === 'main' ? 'main-window' : 'app', ...value })
}
const memory = { v8: { usedBytes: 1024, totalBytes: 4096 }, oilpan: { allocatedBytes: 2048, totalBytes: 8192 }, privateBytes: 16384 }
const counters = { imTransactions: 4, presenceBatches: 2, presenceIds: 205, contactsProviderRenders: 3 }

describe('on-demand renderer metrics collection', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    mock.bus = new EventEmitter()
    mock.all.mockReset().mockReturnValue([])
  })
  afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

  it('does no enumeration, IPC or timer work before being called', async () => {
    await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    expect(mock.all).not.toHaveBeenCalled()
    expect(mock.bus.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('deduplicates OS processes, prefers the counter-owning window, and derives pid from sender', async () => {
    const main = contents(1, 100, 'main')
    const app = contents(2, 200)
    const duplicate = contents(3, 100, 'other')
    mock.all.mockReturnValue([duplicate, app, main])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    expect(collectRendererMetrics()).toBe(result)
    expect(mock.all).toHaveBeenCalledTimes(1)
    expect(duplicate.send).not.toHaveBeenCalled()
    reply(main, RENDERER_METRICS_REPLY, { ...memory, pid: 999 })
    reply(app, RENDERER_METRICS_REPLY, memory)
    reply(main, PERF_COUNTERS_REPLY, { counters })
    expect(await result).toEqual([{ pid: 100, source: 'main-window', ...memory, counters }, { pid: 200, source: 'app', ...memory }])
    expect(mock.bus.eventNames()).toEqual([])
    expect(main.listenerCount('destroyed')).toBe(0)
    expect(app.listenerCount('destroyed')).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('ignores replies from other requests, contents, and subframes', async () => {
    const app = contents(1, 100)
    mock.all.mockReturnValue([app])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    const requestId = app.send.mock.calls[0][1].requestId
    mock.bus.emit(RENDERER_METRICS_REPLY, { sender: app, senderFrame: app.mainFrame }, { requestId: 'wrong', ...memory })
    mock.bus.emit(RENDERER_METRICS_REPLY, { sender: contents(2, 100), senderFrame: app.mainFrame }, { requestId, ...memory })
    mock.bus.emit(RENDERER_METRICS_REPLY, { sender: app, senderFrame: {} }, { requestId, ...memory })
    expect(vi.getTimerCount()).toBe(1)
    reply(app, RENDERER_METRICS_REPLY, memory)
    expect(await result).toEqual([{ pid: 100, source: 'app', ...memory }])
  })

  it.each(['counter-first', 'native-first'])('learns main-window source from its preload, including dev URLs (%s)', async (order) => {
    const main = contents(1, 100, 'other')
    mock.all.mockReturnValue([main])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    const native = () => reply(main, RENDERER_METRICS_REPLY, { ...memory, source: 'main-window' })
    const counter = () => reply(main, PERF_COUNTERS_REPLY, { counters })
    if (order === 'counter-first') { counter(); native() } else { native(); counter() }
    expect(await result).toEqual([{ pid: 100, source: 'main-window', ...memory, counters }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('marks missing replies unavailable without filling in zero metrics', async () => {
    const app = contents(1, 100)
    mock.all.mockReturnValue([app])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual([{ pid: 100, source: 'app', unavailable: 'memory: no response within 1000ms' }])
    expect(mock.bus.eventNames()).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('retains native readings when only counters time out', async () => {
    const main = contents(1, 100, 'main')
    mock.all.mockReturnValue([main])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    reply(main, RENDERER_METRICS_REPLY, memory)
    await vi.advanceTimersByTimeAsync(1000)
    expect(await result).toEqual([{ pid: 100, source: 'main-window', ...memory, unavailable: 'counters: no response within 1000ms' }])
  })

  it('preserves both counter and native API errors regardless of reply order', async () => {
    const main = contents(1, 100, 'main')
    mock.all.mockReturnValue([main])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    reply(main, PERF_COUNTERS_REPLY, { counters: {} })
    reply(main, RENDERER_METRICS_REPLY, { oilpan: memory.oilpan, unavailable: 'V8 unsupported' })
    const [row] = await result
    expect(row.oilpan).toEqual(memory.oilpan)
    expect(row.unavailable).toContain('invalid renderer counters')
    expect(row.unavailable).toContain('V8 unsupported')
    expect(row).not.toHaveProperty('counters')
  })

  it('rejects invalid native sizes as unavailable', async () => {
    const app = contents(1, 100)
    mock.all.mockReturnValue([app])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    reply(app, RENDERER_METRICS_REPLY, { privateBytes: -1 })
    expect(await result).toEqual([{ pid: 100, source: 'app', unavailable: 'Error: invalid private memory' }])
  })

  it('does not attribute a reply to the pid that existed before navigation', async () => {
    const app = contents(1, 100)
    mock.all.mockReturnValue([app])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    app.pid = 200
    reply(app, RENDERER_METRICS_REPLY, memory)
    expect(await result).toEqual([{ pid: 100, source: 'app', unavailable: 'Error: renderer process changed during sample' }])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('settles and cleans up immediately when a renderer is destroyed', async () => {
    const app = contents(1, 100)
    mock.all.mockReturnValue([app])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    const result = collectRendererMetrics()
    app.dead = true
    app.emit('destroyed')
    expect(await result).toEqual([{ pid: 100, source: 'app', unavailable: 'renderer destroyed during sample' }])
    expect(vi.getTimerCount()).toBe(0)
    expect(app.listenerCount('destroyed')).toBe(0)
  })

  it('cleans up a failed send, and does not poll after completing', async () => {
    const app = contents(1, 100)
    app.send.mockImplementation(() => { throw new Error('closed') })
    mock.all.mockReturnValue([app])
    const { collectRendererMetrics } = await import('../../../../apps/desktop/electron/session/main/core/resource-monitor/renderer-metrics')
    expect(await collectRendererMetrics()).toEqual([{ pid: 100, source: 'app', unavailable: 'request failed: Error: closed' }])
    vi.advanceTimersByTime(60_000)
    expect(app.send).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })
})
