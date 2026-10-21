import { describe, expect, it } from 'vitest';
import type { PerfCounters } from '@shared/renderer-metrics';
import type { ResourceSnapshot } from '@shared/resource-monitor';
import { createAltClickCounter, internalsRows } from './resource-monitor-internals';

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

describe('createAltClickCounter', () => {
  it('fires on the fifth consecutive Alt-click and starts over', () => {
    let t = 0;
    const counter = createAltClickCounter(() => t);
    const clicks = (n: number, alt = true) => Array.from({ length: n }, () => { t += 100; return counter.click(alt); });
    expect(clicks(5)).toEqual([false, false, false, false, true]);
    expect(clicks(4)).toEqual([false, false, false, false]);
    expect(clicks(1)).toEqual([true]);
  });

  it('breaks the run on a plain click or a long pause', () => {
    let t = 0;
    const counter = createAltClickCounter(() => t);
    for (let i = 0; i < 4; i++) { t += 100; counter.click(true); }
    t += 100;
    expect(counter.click(false)).toBe(false);
    for (let i = 0; i < 4; i++) { t += 100; counter.click(true); }
    t += 5000;
    expect(counter.click(true)).toBe(false);
  });
});
