import { randomUUID } from 'node:crypto';
import { ipcMain, webContents, type IpcMainEvent, type WebContents } from 'electron';
import {
  metricsRequestId, PERF_COUNTERS_REPLY, RENDERER_METRICS_REPLY, RENDERER_METRICS_REQUEST,
  type PerfCounters, type RendererMemoryMetrics, type RendererMetrics,
} from '@shared/renderer-metrics';

const RESPONSE_TIMEOUT_MS = 1000;
const COUNTER_KEYS = ['imTransactions', 'presenceBatches', 'presenceIds', 'contactsProviderRenders'] as const;
let inFlight: Promise<RendererMetrics[]> | null = null;

/** No periodic work: callers own the existing monitor's open/closed lifecycle. */
export function collectRendererMetrics(): Promise<RendererMetrics[]> {
  inFlight ??= collectOnce().finally(() => { inFlight = null; });
  return inFlight;
}

function sourceOf(contents: WebContents): RendererMetrics['source'] {
  if (contents.getType() === 'webview') return 'app';
  if (contents.getURL().startsWith('gugu-app://app/')) return 'main-window';
  return 'other';
}

function size(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 0; }
function readMemory(value: unknown): RendererMemoryMetrics {
  const memory = value as RendererMemoryMetrics;
  if (memory.v8 !== undefined && (!memory.v8 || !size(memory.v8.usedBytes) || !size(memory.v8.totalBytes))) throw new Error('invalid V8 metrics');
  if (memory.oilpan !== undefined && (!memory.oilpan || !size(memory.oilpan.allocatedBytes) || !size(memory.oilpan.totalBytes))) throw new Error('invalid Oilpan metrics');
  if (memory.privateBytes !== undefined && !size(memory.privateBytes)) throw new Error('invalid private memory');
  if (memory.unavailable !== undefined && typeof memory.unavailable !== 'string') throw new Error('invalid availability');
  if (!memory.v8 && !memory.oilpan && memory.privateBytes === undefined && !memory.unavailable) throw new Error('empty memory response');
  return { v8: memory.v8, oilpan: memory.oilpan, privateBytes: memory.privateBytes, unavailable: memory.unavailable };
}

type Pending = { contents: WebContents; row: RendererMetrics; waiting: Set<'memory' | 'counters'>; counterReceived: boolean; destroyed: () => void };

async function collectOnce(): Promise<RendererMetrics[]> {
  // Several WebContents can share an OS process. Prefer the main window, whose
  // renderer also owns the source counters, then an App, then any other page.
  const byPid = new Map<number, WebContents>();
  const rank = { 'main-window': 0, app: 1, other: 2 };
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue;
    const pid = contents.getOSProcessId();
    if (pid <= 0) continue;
    const previous = byPid.get(pid);
    if (!previous || rank[sourceOf(contents)] < rank[sourceOf(previous)]) byPid.set(pid, contents);
  }
  if (byPid.size === 0) return [];

  return new Promise((resolve) => {
    const requestId = randomUUID();
    const pending = new Map<number, Pending>();
    let finished = false;
    const unavailable = (entry: Pending, reason: string): void => {
      entry.row.unavailable = [entry.row.unavailable, reason].filter(Boolean).join('; ');
    };
    const finish = (): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      ipcMain.removeListener(RENDERER_METRICS_REPLY, onMemory);
      ipcMain.removeListener(PERF_COUNTERS_REPLY, onCounters);
      for (const entry of pending.values()) entry.contents.removeListener('destroyed', entry.destroyed);
      resolve([...pending.values()].map((entry) => entry.row));
    };
    const maybeFinish = (): void => { if ([...pending.values()].every((entry) => entry.waiting.size === 0)) finish(); };
    const entryFor = (event: IpcMainEvent, value: unknown, kind: 'memory' | 'counters'): Pending | undefined => {
      if (metricsRequestId(value) !== requestId) return;
      const entry = pending.get(event.sender.id);
      if (!entry || (kind === 'memory' ? !entry.waiting.has('memory') : entry.counterReceived)) return;
      try {
        if (entry.contents.isDestroyed() || entry.contents.getOSProcessId() !== entry.row.pid) throw new Error('renderer process changed during sample');
        if (event.senderFrame !== entry.contents.mainFrame) return;
      } catch (error) { unavailable(entry, String(error)); entry.waiting.clear(); maybeFinish(); return; }
      return entry;
    };
    const onMemory = (event: IpcMainEvent, value: unknown): void => {
      const entry = entryFor(event, value, 'memory');
      if (!entry) return;
      try {
        const source = (value as { source?: unknown }).source;
        if (source !== 'main-window' && source !== 'app') throw new Error('invalid preload source');
        entry.row.source = source;
        if (source === 'main-window' && !entry.counterReceived) entry.waiting.add('counters');
        else { entry.waiting.delete('counters'); if (source === 'app') delete entry.row.counters; }
        const { unavailable: reason, ...memory } = readMemory(value);
        Object.assign(entry.row, memory);
        if (reason) unavailable(entry, reason);
      }
      catch (error) { unavailable(entry, String(error)); }
      entry.waiting.delete('memory');
      maybeFinish();
    };
    const onCounters = (event: IpcMainEvent, value: unknown): void => {
      const entry = entryFor(event, value, 'counters');
      if (!entry) return;
      entry.counterReceived = true;
      const counters = (value as { counters?: PerfCounters }).counters;
      if (counters && COUNTER_KEYS.every((key) => Number.isSafeInteger(counters[key]) && counters[key] >= 0)) {
        entry.row.counters = Object.fromEntries(COUNTER_KEYS.map((key) => [key, counters[key]])) as unknown as PerfCounters;
      } else unavailable(entry, 'invalid renderer counters');
      entry.waiting.delete('counters');
      maybeFinish();
    };
    for (const [pid, contents] of byPid) {
      const source = sourceOf(contents);
      const entry: Pending = { contents, row: { pid, source }, counterReceived: false, waiting: new Set<'memory' | 'counters'>(source === 'main-window' ? ['memory', 'counters'] : ['memory']), destroyed: () => {
        unavailable(entry, 'renderer destroyed during sample'); entry.waiting.clear(); maybeFinish();
      } };
      pending.set(contents.id, entry);
    }
    ipcMain.on(RENDERER_METRICS_REPLY, onMemory);
    ipcMain.on(PERF_COUNTERS_REPLY, onCounters);
    // A bounded request deadline, not a sampling timer. An unresponsive renderer
    // must produce an explicit missing reading instead of hanging the monitor.
    const timeout = setTimeout(() => {
      for (const entry of pending.values()) if (entry.waiting.size) unavailable(entry, `${[...entry.waiting].join(', ')}: no response within ${RESPONSE_TIMEOUT_MS}ms`);
      finish();
    }, RESPONSE_TIMEOUT_MS);
    for (const entry of pending.values()) {
      if (finished) break;
      entry.contents.once('destroyed', entry.destroyed);
      try { entry.contents.send(RENDERER_METRICS_REQUEST, { requestId }); }
      catch (error) { unavailable(entry, `request failed: ${String(error)}`); entry.waiting.clear(); }
    }
    maybeFinish();
  });
}
