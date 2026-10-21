import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const metrics = vi.fn();
vi.mock('electron', () => ({ app: { getAppMetrics: () => metrics() } }));
vi.mock('pidusage', () => ({ default: Object.assign(vi.fn(), { clear: vi.fn() }) }));
vi.mock('@main/core/pty/pty-session-registry', () => ({ ptySessionRegistry: { listActiveSessions: () => [] } }));
vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: { get: async () => ({ enabled: true, internals: false }) },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn() } }));
vi.mock('./renderer-metrics', () => ({ collectRendererMetrics: vi.fn() }));

function tab(cumulativeCPUUsage: number, pid = 7) {
  return { pid, type: 'Tab', cpu: { percentCPUUsage: 0, cumulativeCPUUsage }, memory: { workingSetSize: 1 } };
}

describe('resource sampler CPU', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

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
