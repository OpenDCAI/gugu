import { randomUUID } from 'node:crypto';
import os from 'node:os';
import { app, BrowserWindow } from 'electron';
import pidusage from 'pidusage';
import { ptySessionRegistry } from '@main/core/pty/pty-session-registry';
import { appSettingsService } from '@main/core/settings/settings-service';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { collectRendererMetrics } from './renderer-metrics';
import { collectAcpResourceRoots } from '../acp/runtime-process/resource-roots';
import { accountProcessTrees, type ResourceProcessRoot } from './process-accounting';
import { listResourceProcesses, collectLedgerResourceRoots } from './owned-processes';
import { collectResourceContext } from './context';
import { resourceHistory } from './history';
import { parsePtySessionId } from '@shared/core/pty/ptySessionId';
import { resourceSnapshotChannel } from '@shared/events/resourceEvents';
import type {
  ResourceAppProcess,
  ResourceAppUsage,
  ResourcePtyEntry,
  ResourceSnapshot,
} from '@shared/resource-monitor';

const SAMPLE_INTERVAL_MS = 1500;
const BACKGROUND_SAMPLE_INTERVAL_MS = 10_000;
const CPU_COUNT = os.cpus().length;
const TOTAL_MEMORY_BYTES = os.totalmem();

type ProcessUsage = { cpu?: number; memory: number; ppid?: number };
type ProcessUsageMap = Record<string, ProcessUsage>;

const runId = randomUUID();
let inFlight: Promise<ResourceSnapshot> | null = null;
export function sampleOnce(): Promise<ResourceSnapshot> {
  inFlight ??= collectSample().finally(() => { inFlight = null; });
  return inFlight;
}
async function collectSample(): Promise<ResourceSnapshot> {
  const active = ptySessionRegistry.listActiveSessions();
  const { usage: appUsage, processes: appProcesses } = sampleAppUsage();
  const roots: ResourceProcessRoot[] = [
    { id: 'electron-main', pid: process.pid, kind: 'electron', label: 'Main' },
    ...appProcesses.map(p => ({ id: `electron:${p.pid}`, pid: p.pid, kind: 'electron' as const, label: p.name ?? p.type })),
    ...active.flatMap(a => typeof a.pid === 'number' && a.pid > 0 ? [{ id: a.ptySessionId, pid: a.pid, kind: 'pty' as const, label: a.metadata?.title ?? a.ptySessionId }] : []),
  ];
  const [processes, acpRoots] = await Promise.all([listResourceProcesses(), collectAcpResourceRoots()]);
  roots.push(...acpRoots, ...await collectLedgerResourceRoots(processes));
  const candidates = accountProcessTrees(roots, processes, {}).pidsByRoot;
  const usage = await samplePidUsage([...new Set([...candidates.values()].flat())]);
  // Electron CPU uses its cumulative baseline; RSS uses the same OS sampler as child processes.
  for (const p of appProcesses) {
    const sampled = usage[String(p.pid)];
    if (sampled) p.memory = sampled.memory;
    usage[String(p.pid)] = { memory: p.memory, cpu: p.cpu, ppid: sampled?.ppid };
  }
  if (appProcesses.length) appUsage.memoryBytes = appProcesses.reduce((sum, p) => sum + p.memory, 0);
  const { groups: processGroups, pidsByRoot } = accountProcessTrees(roots, processes, usage);

  const entries: ResourcePtyEntry[] = [];
  for (const a of active) {
    const parsed = parsePtySessionId(a.ptySessionId);
    if (!parsed) continue;
    const tree = typeof a.pid === 'number' ? pidsByRoot.get(a.ptySessionId) : undefined;
    const u = tree ? aggregateProcessUsage(tree, usage) : undefined;
    if (typeof a.pid === 'number' && !processes.some(p => p.pid === a.pid)) continue;
    entries.push({
      ptySessionId: a.ptySessionId,
      projectId: parsed.projectId,
      scopeId: parsed.scopeId,
      leafId: parsed.leafId,
      pid: a.pid,
      ppid: typeof a.pid === 'number' ? usage[String(a.pid)]?.ppid : undefined,
      cpu: u?.cpu ?? 0,
      memory: u?.memory ?? 0,
      providerId: a.metadata?.providerId,
      title: a.metadata?.title,
    });
  }

  return {
    timestamp: Date.now(),
    runId,
    context: await collectResourceContext(),
    cpuCount: CPU_COUNT,
    totalMemoryBytes: TOTAL_MEMORY_BYTES,
    app: appUsage,
    appProcesses,
    entries,
    processGroups,
    memoryMetric: 'rss',
    ...(hasResourceMonitorInternals() ? { internals: { renderers: await collectRendererMetrics() } } : {}),
  };
}

async function samplePidUsage(localPids: number[]): Promise<ProcessUsageMap> {
  if (localPids.length === 0) return {};
  try {
    return await pidusage(localPids);
  } catch {
    // A dead PID rejects the whole batch — fall back to per-pid sampling in parallel.
    const usage: ProcessUsageMap = {};
    const results = await Promise.allSettled(localPids.map((pid) => pidusage(pid)));
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        usage[String(localPids[i])] = {
          cpu: r.value.cpu,
          memory: r.value.memory,
          ppid: r.value.ppid,
        };
      }
    });
    return usage;
  }
}

function aggregateProcessUsage(pids: number[], usage: ProcessUsageMap): ProcessUsage | undefined {
  let cpu = 0;
  let memory = 0;
  let found = false;
  for (const pid of pids) {
    const item = usage[String(pid)];
    if (!item) continue;
    found = true;
    cpu += item.cpu ?? 0;
    memory += item.memory;
  }
  return found ? { cpu, memory } : undefined;
}

/**
 * Sum memory + CPU across all Electron processes (main, renderer, GPU, utility)
 * and capture each row individually. `workingSetSize` is reported in KiB.
 *
 * @@@cpu-from-cumulative - CPU is the `cpu.cumulativeCPUUsage` delta since a baseline at least
 * MIN_CPU_INTERVAL_MS old, as % of one core; a process with no baseline has no reading yet.
 * `percentCPUUsage` is not used: on mac1 (Electron 44, 10-21) a renderer at ~2% of a core by ps
 * cputime (which `cumulativeCPUUsage` matched to the centisecond) reported 0.08-0.29%.
 */
const MIN_CPU_INTERVAL_MS = 1000;
let cpuBaseline: { at: number; seconds: Map<number, number> } | null = null;

function sampleAppUsage(): { usage: ResourceAppUsage; processes: ResourceAppProcess[] } {
  try {
    const metrics = app.getAppMetrics();
    if (!metrics.length) throw new Error('Application process metrics were empty');
    const now = Date.now();
    const base = cpuBaseline && now - cpuBaseline.at >= MIN_CPU_INTERVAL_MS ? cpuBaseline : null;
    const seconds = new Map<number, number>();
    let memoryBytes = 0;
    let cpuPercent: number | undefined;
    const processes: ResourceAppProcess[] = [];
    for (const m of metrics) {
      const memBytes = m.memory.workingSetSize * 1024;
      memoryBytes += memBytes;
      const total = m.cpu.cumulativeCPUUsage;
      if (total !== undefined) seconds.set(m.pid, total);
      const before = base?.seconds.get(m.pid);
      const cpu =
        base && total !== undefined && before !== undefined && total >= before
          ? ((total - before) / ((now - base.at) / 1000)) * 100
          : undefined;
      if (cpu !== undefined) cpuPercent = (cpuPercent ?? 0) + cpu;
      processes.push({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName, cpu, memory: memBytes });
    }
    if (!cpuBaseline || base) cpuBaseline = { at: now, seconds };
    return { usage: { memoryBytes, cpuPercent }, processes };
  } catch (err) {
    log.warn('resource-sampler: app metrics failed', err);
    return { usage: {}, processes: [] };
  }
}

let timer: NodeJS.Timeout | null = null;
let sampling = false;
const openSubscriptions = new Map<string, boolean>();
const latestSequenceByClient = new Map<string, number>();

/** Advanced diagnostics belong to the open page, never to a persisted setting. */
export function hasResourceMonitorInternals(): boolean {
  return [...openSubscriptions.values()].some(Boolean);
}

export function startResourceSampler(): void {
  if (timer) return;
  app.on('browser-window-focus', sampleSoon);
  sampleSoon();
}

function sampleSoon(): void {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), 0);
}

async function tick(): Promise<void> {
  if (sampling) return; // A reopened panel waits for the previous collection to finish.
  sampling = true;
  const current = timer;
  let snap: ResourceSnapshot | null = null;
  try {
    snap = await sampleOnce();
  } catch (err) {
    log.warn('resource-sampler: sample failed', err);
  }
  sampling = false;
  if (!timer) return;
  if (timer !== current) return sampleSoon();
  if (snap) {
    try { resourceHistory.append(snap); }
    catch (error) { snap.recordingError = 'write-failed'; log.warn('resource history write failed', error); }
  }
  if (openSubscriptions.size) events.emit(resourceSnapshotChannel, snap);
  // The monitor covers the whole app: a foreground auxiliary window also counts.
  const delay = BrowserWindow.getFocusedWindow() ? SAMPLE_INTERVAL_MS : BACKGROUND_SAMPLE_INTERVAL_MS;
  timer = setTimeout(() => void tick(), delay);
}

export function stopResourceSampler(): void {
  if (timer) {
    clearTimeout(timer);
    timer = null;
    app.off('browser-window-focus', sampleSoon);
    cpuBaseline = null;
    try {
      pidusage.clear();
    } catch {
      // ignore
    }
  }
}

export function setResourceMonitorOpen(
  clientId: string,
  subscriptionId: string,
  open: boolean,
  sequence: number,
  internals: boolean
): void {
  const latestSequence = latestSequenceByClient.get(clientId) ?? 0;
  if (sequence <= latestSequence) return;
  latestSequenceByClient.set(clientId, sequence);
  if (open) {
    openSubscriptions.set(subscriptionId, internals);
  } else {
    openSubscriptions.delete(subscriptionId);
  }
  void reconcileResourceSampler();
}

export async function reconcileResourceSampler(): Promise<void> {
  try {
    const { enabled } = await appSettingsService.get('resourceMonitor');
    if (enabled) startResourceSampler();
    else stopResourceSampler();
  } catch (err) {
    log.warn('resource-sampler: failed to read settings', err);
  } finally {
    if (!timer && openSubscriptions.size > 0) events.emit(resourceSnapshotChannel, null);
  }
}
