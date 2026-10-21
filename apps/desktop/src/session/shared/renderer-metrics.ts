/** Internal diagnostics only. All sizes crossing IPC are bytes. */
export interface PerfCounters {
  imTransactions: number;
  presenceBatches: number;
  presenceIds: number;
  contactsProviderRenders: number;
}

export interface RendererMemoryMetrics {
  v8?: { usedBytes: number; totalBytes: number };
  oilpan?: { allocatedBytes: number; totalBytes: number };
  privateBytes?: number;
  unavailable?: string;
}

export interface RendererMetrics extends RendererMemoryMetrics {
  pid: number;
  source: 'main-window' | 'app' | 'other';
  counters?: PerfCounters;
}

export const RENDERER_METRICS_REQUEST = 'resource-monitor:collect-renderer';
export const RENDERER_METRICS_REPLY = 'resource-monitor:renderer-memory';
export const PERF_COUNTERS_REPLY = 'resource-monitor:renderer-counters';

export function metricsRequestId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const id = (value as { requestId?: unknown }).requestId;
  return typeof id === 'string' && id.length > 0 ? id : null;
}
