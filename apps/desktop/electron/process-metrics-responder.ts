import type { IpcRenderer } from 'electron'
import { metricsRequestId, RENDERER_METRICS_REPLY, RENDERER_METRICS_REQUEST, type RendererMemoryMetrics } from '../src/session/shared/renderer-metrics'

interface MetricsProcess {
  isMainFrame?: boolean
  getHeapStatistics(): { usedHeapSize: number; totalHeapSize: number }
  getBlinkMemoryInfo(): { allocated: number; total: number }
  getProcessMemoryInfo(): Promise<{ private: number }>
}

function bytes(kib: number): number {
  if (!Number.isFinite(kib) || kib < 0) throw new Error('invalid KiB size')
  return kib * 1024
}

/** Electron supports these APIs in sandbox preloads too; no page API is exposed. */
export function installProcessMetricsResponder(ipc: Pick<IpcRenderer, 'on' | 'removeListener' | 'send'>, current: MetricsProcess, source: 'main-window' | 'app'): () => void {
  if (current.isMainFrame === false) return () => {}
  const listener = (_event: unknown, request: unknown): void => {
    const requestId = metricsRequestId(request)
    if (!requestId) return
    void readMemory(current).then((memory) => ipc.send(RENDERER_METRICS_REPLY, { requestId, source, ...memory }))
  }
  ipc.on(RENDERER_METRICS_REQUEST, listener)
  return () => { ipc.removeListener(RENDERER_METRICS_REQUEST, listener) }
}

async function readMemory(current: MetricsProcess): Promise<RendererMemoryMetrics> {
  const result: RendererMemoryMetrics = {}
  const errors: string[] = []
  try {
    const heap = current.getHeapStatistics()
    result.v8 = { usedBytes: bytes(heap.usedHeapSize), totalBytes: bytes(heap.totalHeapSize) }
  } catch (error) { errors.push(`V8: ${String(error)}`) }
  try {
    const blink = current.getBlinkMemoryInfo()
    result.oilpan = { allocatedBytes: bytes(blink.allocated), totalBytes: bytes(blink.total) }
  } catch (error) { errors.push(`Oilpan: ${String(error)}`) }
  try { result.privateBytes = bytes((await current.getProcessMemoryInfo()).private) }
  catch (error) { errors.push(`private memory: ${String(error)}`) }
  if (errors.length) result.unavailable = errors.join('; ')
  return result
}
