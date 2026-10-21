import { metricsRequestId, PERF_COUNTERS_REPLY, RENDERER_METRICS_REQUEST } from '../session/shared/renderer-metrics'
import { readPerfCounters } from './perfCounters'

interface CounterBridge {
  eventOn(channel: string, callback: (data: unknown) => void): () => void
  eventSend(channel: string, data: unknown): void
}

/** The existing desktop bridge supplies main's requests; web/mobile do nothing. */
export function installPerfCounterResponder(bridge: CounterBridge | undefined): () => void {
  if (!bridge) return () => {}
  return bridge.eventOn(RENDERER_METRICS_REQUEST, (request) => {
    const requestId = metricsRequestId(request)
    if (requestId) bridge.eventSend(PERF_COUNTERS_REPLY, { requestId, counters: readPerfCounters() })
  })
}
