import { describe, expect, it } from 'vitest';
import type { PerfCounters } from '@shared/renderer-metrics';
import type { ResourceSnapshot } from '@shared/resource-monitor';
import { internalsRows } from './resource-monitor-internals';

function counters(n: number): PerfCounters {
  return { imTransactions: n, presenceBatches: n, presenceIds: n * 10, contactsProviderRenders: n };
}

function snap(timestamp: number, n: number, pid = 7): ResourceSnapshot {
  return {
    timestamp,
    cpuCount: 1,
    totalMemoryBytes: 0,
    app: { memoryBytes: 0 },
    appProcesses: [{ pid, type: 'Tab', memory: 0 }],
    entries: [],
    internals: { renderers: [{ pid, source: 'main-window', privateBytes: 1, counters: counters(n) }] },
  };
}

describe('internalsRows', () => {
  it('turns cumulative counters into per-second rates', () => {
    const [row] = internalsRows(snap(0, 100), snap(2000, 104));
    expect(row.counterRates).toEqual({ imTransactions: 2, presenceBatches: 2, presenceIds: 20, contactsProviderRenders: 2 });
  });

  it('has no rate on the first sample', () => {
    expect(internalsRows(null, snap(2000, 104))[0].counterRates).toBeUndefined();
  });

  it('resets the baseline when counters go backwards (renderer reloaded)', () => {
    expect(internalsRows(snap(0, 100), snap(2000, 3))[0].counterRates).toBeUndefined();
  });

  it('does not difference across different processes', () => {
    expect(internalsRows(snap(0, 100, 7), snap(2000, 104, 8))[0].counterRates).toBeUndefined();
  });
});
