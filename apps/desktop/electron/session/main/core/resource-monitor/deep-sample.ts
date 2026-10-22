import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { app, contentTracing } from 'electron';
import type { ResourceSnapshot } from '@shared/resource-monitor';

/**
 * Deep sample — one Chromium memory-infra dump of every process, for a local JSON file the user saves.
 * It is the only place that runs a trace; it runs on a click, never on a timer. Nothing is uploaded.
 *
 * The trace records `disabled-by-default-memory-infra` with one periodic background-dump trigger (periodic dumps never force a GC,
 * so the garbage that dominates the heap stays in the reading), long enough for at least one dump
 * per process, then stops; the raw trace goes to a temp file that is read once and deleted.
 */
const DUMP_INTERVAL_MS = 250;
const RECORD_MS = 900;

export interface ProcessMemoryDump {
  pid: number;
  privateFootprintBytes?: number;
  /** Allocator name → size in bytes, for the allocators that matter here. */
  allocators: Partial<Record<'blink_gc' | 'v8' | 'partition_alloc' | 'malloc', number>>;
}

type TraceEvent = { ph?: string; pid?: number; args?: { dumps?: { process_totals?: Record<string, string>; allocators?: Record<string, { attrs?: { size?: { value?: string } } }> } } };

const ALLOCATORS = ['blink_gc', 'v8', 'partition_alloc', 'malloc'] as const;

/** Per pid, the last dump's totals. Sizes in memory-infra are hex strings of bytes. */
export function summarizeMemoryDumps(events: readonly TraceEvent[]): ProcessMemoryDump[] {
  const byPid = new Map<number, ProcessMemoryDump>();
  for (const event of events) {
    const dumps = event.args?.dumps;
    if (event.ph !== 'v' || typeof event.pid !== 'number' || !dumps) continue;
    const row = byPid.get(event.pid) ?? { pid: event.pid, allocators: {} };
    const footprint = dumps.process_totals?.private_footprint_bytes;
    if (footprint !== undefined) row.privateFootprintBytes = parseInt(footprint, 16);
    for (const name of ALLOCATORS) {
      const value = dumps.allocators?.[name]?.attrs?.size?.value;
      if (value !== undefined) row.allocators[name] = parseInt(value, 16);
    }
    byPid.set(event.pid, row);
  }
  return [...byPid.values()].sort((a, b) => a.pid - b.pid);
}

async function recordMemoryDumps(): Promise<ProcessMemoryDump[]> {
  await contentTracing.startRecording({
    included_categories: ['disabled-by-default-memory-infra'],
    excluded_categories: ['*'],
    memory_dump_config: { triggers: [{ mode: 'background', periodic_interval_ms: DUMP_INTERVAL_MS }] },
  });
  await new Promise((resolve) => setTimeout(resolve, RECORD_MS));
  const tracePath = path.join(os.tmpdir(), `gugu-deep-sample-${process.pid}-${Date.now()}.json`);
  const written = await contentTracing.stopRecording(tracePath);
  try {
    const trace = JSON.parse(await readFile(written, 'utf8')) as { traceEvents?: TraceEvent[] } | TraceEvent[];
    const events = Array.isArray(trace) ? trace : (trace.traceEvents ?? []);
    const dumps = summarizeMemoryDumps(events);
    if (dumps.length === 0) throw new Error('memory-infra trace contained no process dumps');
    return dumps;
  } finally {
    await rm(written, { force: true });
  }
}

/** The JSON the user saves: the monitor's current snapshot plus one memory dump per process. */
export async function captureDeepSample(snapshot: ResourceSnapshot, timeline?: unknown): Promise<string> {
  const memoryDumps = await recordMemoryDumps();
  return JSON.stringify({
    format: 'gugu-resource-monitor-deep-sample/1',
    capturedAt: new Date().toISOString(),
    app: { version: app.getVersion(), platform: process.platform, arch: process.arch, electron: process.versions.electron },
    snapshot,
    timeline,
    memoryDumps,
  }, null, 2);
}
