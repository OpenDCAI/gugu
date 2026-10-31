import type { PerfCounters, RendererMetrics } from '@shared/renderer-metrics';
import type { ResourceSnapshot } from '@shared/resource-monitor';

export const PERF_COUNTER_KEYS = ['imTransactions', 'presenceBatches', 'presenceIds', 'contactsProviderRenders'] as const;

export interface InternalsRow extends RendererMetrics {
  /** Counter increments per second over the last sample interval; undefined until two comparable samples exist. */
  counterRates?: PerfCounters;
}

/**
 * One row per renderer in `next`, with counter rates against `prev` when both
 * samples saw the same pid. Counters that went backwards (the renderer module
 * reloaded) have no rate: the next sample uses them as the new baseline.
 */
export function internalsRows(prev: ResourceSnapshot | null, next: ResourceSnapshot): InternalsRow[] {
  const renderers = next.internals?.renderers ?? [];
  const seconds = prev ? (next.timestamp - prev.timestamp) / 1000 : 0;
  return renderers.map((renderer) => {
    const row: InternalsRow = { ...renderer };
    const before = prev?.internals?.renderers.find((r) => r.pid === renderer.pid)?.counters;
    const now = renderer.counters;
    if (seconds > 0 && now && before && PERF_COUNTER_KEYS.every((key) => now[key] >= before[key])) {
      row.counterRates = Object.fromEntries(
        PERF_COUNTER_KEYS.map((key) => [key, (now[key] - before[key]) / seconds]),
      ) as unknown as PerfCounters;
    }
    return row;
  });
}
