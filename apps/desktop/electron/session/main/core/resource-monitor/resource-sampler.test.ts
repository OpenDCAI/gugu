import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceSnapshotChannel } from '@shared/events/resourceEvents';

const metrics = vi.fn();
const focusedWindow = vi.fn();
const settings = vi.fn();
const emit = vi.fn();
const collect = vi.fn();
const appEvents = new EventEmitter();
vi.mock('electron', () => ({
  app: {
    getAppMetrics: () => metrics(),
    on: (event: string, listener: () => void) => appEvents.on(event, listener),
    off: (event: string, listener: () => void) => appEvents.off(event, listener),
  },
  BrowserWindow: { getFocusedWindow: () => focusedWindow() },
}));
vi.mock('pidusage', () => ({ default: Object.assign(vi.fn(), { clear: vi.fn() }) }));
vi.mock('@main/core/pty/pty-session-registry', () => ({ ptySessionRegistry: { listActiveSessions: () => [] } }));
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: () => settings() },
}));
vi.mock('@main/lib/events', () => ({ events: { emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./renderer-metrics', () => ({ collectRendererMetrics: collect }));

function tab(cumulativeCPUUsage: number, pid = 7) {
  return { pid, type: 'Tab', cpu: { percentCPUUsage: 0, cumulativeCPUUsage }, memory: { workingSetSize: 1 } };
}

beforeEach(() => {
  vi.resetAllMocks();
  appEvents.removeAllListeners();
  metrics.mockReturnValue([]);
  focusedWindow.mockReturnValue({});
  settings.mockResolvedValue({ enabled: true, internals: false });
  collect.mockResolvedValue([]);
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(async () => {
  (await import('./resource-sampler')).stopResourceSampler();
  vi.useRealTimers();
  vi.resetModules();
});

describe('resource sampler CPU', () => {
  it('reports CPU as the cumulativeCPUUsage delta, with no reading before a baseline', async () => {
    const { sampleOnce } = await import('./resource-sampler');
    metrics.mockReturnValue([tab(10)]);
    const first = await sampleOnce();
    expect(first.appProcesses[0].cpu).toBeUndefined();
    expect(first.app.cpuPercent).toBeUndefined();

    vi.setSystemTime(2000);
    metrics.mockReturnValue([tab(11)]);
    const second = await sampleOnce();
    expect(second.appProcesses[0].cpu).toBeCloseTo(50);
    expect(second.app.cpuPercent).toBeCloseTo(50);
  });

  it('does not difference over a too-short interval or across a new pid', async () => {
    const { sampleOnce } = await import('./resource-sampler');
    metrics.mockReturnValue([tab(10)]);
    await sampleOnce();
    vi.setSystemTime(200);
    metrics.mockReturnValue([tab(10.1)]);
    expect((await sampleOnce()).appProcesses[0].cpu).toBeUndefined();
    // the 0 ms baseline was kept, so 1.5 s after it the rate covers the whole 1.5 s
    vi.setSystemTime(1500);
    metrics.mockReturnValue([tab(10.75), tab(3, 8)]);
    const rows = (await sampleOnce()).appProcesses;
    expect(rows[0].cpu).toBeCloseTo(50);
    expect(rows[1].cpu).toBeUndefined();
  });

  it('forgets the baseline when the sampler stops', async () => {
    const { sampleOnce, stopResourceSampler, startResourceSampler } = await import('./resource-sampler');
    metrics.mockReturnValue([tab(10)]);
    await sampleOnce();
    startResourceSampler();
    stopResourceSampler();
    vi.setSystemTime(60_000);
    metrics.mockReturnValue([tab(40)]);
    expect((await sampleOnce()).appProcesses[0].cpu).toBeUndefined();
  });
});

describe('resource sampler cadence', () => {
  it('does no work and installs no focus listener before a panel opens', async () => {
    await import('./resource-sampler');
    appEvents.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(metrics).not.toHaveBeenCalled();
    expect(collect).not.toHaveBeenCalled();
    expect(appEvents.listenerCount('browser-window-focus')).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses 1.5 seconds in front, 10 seconds behind, and samples immediately on focus', async () => {
    const { startResourceSampler } = await import('./resource-sampler');
    startResourceSampler();
    startResourceSampler();
    await vi.advanceTimersByTimeAsync(0);
    expect(metrics).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1500);
    expect(metrics).toHaveBeenCalledTimes(2);

    focusedWindow.mockReturnValue(null);
    // Finish the already scheduled foreground interval, then use the background delay.
    await vi.advanceTimersByTimeAsync(1500);
    expect(metrics).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(9999);
    expect(metrics).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(metrics).toHaveBeenCalledTimes(4);

    focusedWindow.mockReturnValue({}); // A foreground auxiliary window also counts.
    appEvents.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(metrics).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(1500);
    expect(metrics).toHaveBeenCalledTimes(6);
    expect(appEvents.listenerCount('browser-window-focus')).toBe(1);
  });

  it('waits for a slow sample to finish before starting the next interval', async () => {
    const { startResourceSampler } = await import('./resource-sampler');
    settings.mockResolvedValue({ enabled: true, internals: true });
    let finish!: (value: []) => void;
    collect.mockReturnValueOnce(new Promise<[]>((resolve) => { finish = resolve; }));
    startResourceSampler();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1499);
    expect(collect).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(collect).toHaveBeenCalledTimes(2);
  });

  it('drops a late result after close and leaves no timer or focus listener', async () => {
    const { startResourceSampler, stopResourceSampler } = await import('./resource-sampler');
    settings.mockResolvedValue({ enabled: true, internals: true });
    let finish!: (value: []) => void;
    collect.mockReturnValueOnce(new Promise<[]>((resolve) => { finish = resolve; }));
    startResourceSampler();
    await vi.advanceTimersByTimeAsync(0);
    stopResourceSampler();
    finish([]);
    appEvents.emit('browser-window-focus');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(collect).toHaveBeenCalledTimes(1);
    expect(emit).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    expect(appEvents.listenerCount('browser-window-focus')).toBe(0);
  });

  it('waits out an old collection on rapid reopen, discards it, and takes a fresh one', async () => {
    const { startResourceSampler, stopResourceSampler } = await import('./resource-sampler');
    settings.mockResolvedValue({ enabled: true, internals: true });
    let finish!: (value: []) => void;
    collect.mockReturnValueOnce(new Promise<[]>((resolve) => { finish = resolve; }));
    startResourceSampler();
    await vi.advanceTimersByTimeAsync(0);
    stopResourceSampler();
    startResourceSampler();
    await vi.advanceTimersByTimeAsync(0);
    expect(collect).toHaveBeenCalledTimes(1);
    finish([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(collect).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(1);
  });

  it('reports an unsuccessful sample and keeps the next interval alive', async () => {
    const { startResourceSampler } = await import('./resource-sampler');
    settings.mockResolvedValue({ enabled: true, internals: true });
    collect.mockRejectedValueOnce(new Error('renderer unavailable'));
    startResourceSampler();
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenNthCalledWith(1, resourceSnapshotChannel, null);
    await vi.advanceTimersByTimeAsync(1500);
    expect(emit).toHaveBeenNthCalledWith(2, resourceSnapshotChannel, expect.objectContaining({ timestamp: 1500 }));
  });

  it('finishes loading when settings disable the sampler or cannot be read', async () => {
    const { setResourceMonitorOpen } = await import('./resource-sampler');
    settings.mockResolvedValueOnce({ enabled: false });
    setResourceMonitorOpen('client', 'panel', true, 1);
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenLastCalledWith(resourceSnapshotChannel, null);
    emit.mockClear();
    settings.mockRejectedValueOnce(new Error('settings unavailable'));
    setResourceMonitorOpen('client', 'panel', true, 2);
    await vi.advanceTimersByTimeAsync(0);
    expect(emit).toHaveBeenCalledWith(resourceSnapshotChannel, null);
    expect(metrics).not.toHaveBeenCalled();
  });
});
