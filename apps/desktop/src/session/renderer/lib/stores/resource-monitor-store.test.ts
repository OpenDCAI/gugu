import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resourceSnapshotChannel } from '@shared/events/resourceEvents';
import type { ResourceSnapshot } from '@shared/resource-monitor';

const setOpen = vi.fn();
const getSnapshot = vi.fn();
let snapshotHandler: ((snap: ResourceSnapshot | null) => void) | null = null;
const offSnapshot = vi.fn(() => { snapshotHandler = null; });

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { resourceMonitor: { setOpen, getSnapshot } },
  events: {
    on: vi.fn((channel: typeof resourceSnapshotChannel, cb: (snap: ResourceSnapshot | null) => void) => {
      if (channel === resourceSnapshotChannel) snapshotHandler = cb;
      return offSnapshot;
    }),
  },
}));

function snapshot(timestamp: number): ResourceSnapshot {
  return {
    timestamp, cpuCount: 1, totalMemoryBytes: 0,
    app: { memoryBytes: 0, cpuPercent: 0 }, appProcesses: [], entries: [],
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ResourceMonitorStore', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    snapshotHandler = null;
    setOpen.mockResolvedValue({ success: true });
    getSnapshot.mockResolvedValue({ success: true, data: null });
    offSnapshot.mockImplementation(() => { snapshotHandler = null; });
  });

  it('subscribes before opening, fetches no duplicate first sample, and disposes idempotently', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    setOpen.mockImplementation(async (_client, _subscription, open) => {
      if (open) snapshotHandler?.(snapshot(1));
      return { success: true };
    });
    const store = new ResourceMonitorStore();
    store.start();
    store.start();
    expect(store.snapshot?.timestamp).toBe(1);
    expect(store.isLoadingInitialSnapshot).toBe(false);
    expect(getSnapshot).not.toHaveBeenCalled();
    store.dispose();
    store.dispose();
    expect(setOpen).toHaveBeenCalledTimes(2);
    const [clientId, subscriptionId] = setOpen.mock.calls[0];
    expect(setOpen).toHaveBeenNthCalledWith(1, clientId, subscriptionId, true, 1, false);
    expect(setOpen).toHaveBeenNthCalledWith(2, clientId, subscriptionId, false, 2, false);
    expect(offSnapshot).toHaveBeenCalledTimes(1);
  });

  it('waits for the first pushed sample rather than the subscription acknowledgement', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    const store = new ResourceMonitorStore();
    store.start();
    await flushPromises();
    expect(store.isLoadingInitialSnapshot).toBe(true);
    snapshotHandler?.(snapshot(2));
    expect(store.snapshot?.timestamp).toBe(2);
    expect(store.isLoadingInitialSnapshot).toBe(false);
  });

  it('requests diagnostics only for an open page and always reopens collapsed', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    const store = new ResourceMonitorStore();
    await store.setInternals(true);
    expect(setOpen).not.toHaveBeenCalled();
    store.start();
    expect(store.internals).toBe(false);
    await store.setInternals(true);
    expect(setOpen.mock.calls[1].slice(2)).toEqual([true, 2, true]);
    expect(store.internals).toBe(true);
    store.dispose();
    expect(store.internals).toBe(false);
    store.start();
    expect(setOpen.mock.lastCall?.slice(2)).toEqual([true, 4, false]);
    expect(store.internals).toBe(false);
  });

  it('does not reopen diagnostics after the page closes during an IPC request', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    const store = new ResourceMonitorStore();
    store.start();
    let finish!: () => void;
    setOpen.mockReturnValueOnce(new Promise<void>((resolve) => { finish = resolve; }));
    const changing = store.setInternals(true);
    store.dispose();
    store.start();
    finish();
    await changing;
    expect(store.internals).toBe(false);
  });

  it('ends loading on a failed sample without clearing the last valid snapshot or baseline', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    const store = new ResourceMonitorStore();
    store.start();
    snapshotHandler?.(null);
    expect(store.isLoadingInitialSnapshot).toBe(false);
    expect(store.snapshot).toBeNull();
    snapshotHandler?.(snapshot(1));
    snapshotHandler?.(snapshot(2));
    snapshotHandler?.(null);
    expect(store.snapshot?.timestamp).toBe(2);
    expect(store.previousSnapshot?.timestamp).toBe(1);
  });

  it('ends loading if opening the subscription fails', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    setOpen.mockRejectedValueOnce(new Error('IPC unavailable'));
    const store = new ResourceMonitorStore();
    store.start();
    await flushPromises();
    expect(store.isLoadingInitialSnapshot).toBe(false);
    expect(store.snapshot).toBeNull();
  });

  it('ignores old sample callbacks and subscription failures after reopen', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    let rejectOpen!: (error: Error) => void;
    setOpen.mockReturnValueOnce(new Promise((_resolve, reject) => { rejectOpen = reject; }));
    const store = new ResourceMonitorStore();
    store.start();
    const oldHandler = snapshotHandler;
    store.dispose();
    store.start();
    oldHandler?.(snapshot(1));
    rejectOpen(new Error('old subscription failed'));
    await flushPromises();
    expect(store.snapshot).toBeNull();
    expect(store.isLoadingInitialSnapshot).toBe(true);
    snapshotHandler?.(snapshot(2));
    expect(store.snapshot?.timestamp).toBe(2);
    expect(store.isLoadingInitialSnapshot).toBe(false);
  });

  it('keeps manual refresh but does not let it overwrite a newer pushed snapshot', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    let finish!: (value: { success: true; data: ResourceSnapshot }) => void;
    getSnapshot.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const store = new ResourceMonitorStore();
    store.start();
    const refreshing = store.refresh();
    snapshotHandler?.(snapshot(2));
    finish({ success: true, data: snapshot(1) });
    await refreshing;
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(store.snapshot?.timestamp).toBe(2);
  });

  it.each([false, true])('discards a late manual refresh after close (reopen=%s)', async (reopen) => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    let finish!: (value: { success: true; data: ResourceSnapshot }) => void;
    getSnapshot.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const store = new ResourceMonitorStore();
    store.start();
    const refreshing = store.refresh();
    store.dispose();
    if (reopen) store.start();
    finish({ success: true, data: snapshot(1) });
    await refreshing;
    expect(store.snapshot).toBeNull();
    expect(store.isLoadingInitialSnapshot).toBe(reopen);
  });

  it('keeps the preceding snapshot for differencing, rejects older events, and resets on reopen', async () => {
    const { ResourceMonitorStore } = await import('./resource-monitor-store');
    const store = new ResourceMonitorStore();
    store.start();
    snapshotHandler?.(snapshot(1));
    snapshotHandler?.(snapshot(2));
    snapshotHandler?.(snapshot(1));
    expect(store.previousSnapshot?.timestamp).toBe(1);
    expect(store.snapshot?.timestamp).toBe(2);
    store.dispose();
    store.start();
    expect(store.snapshot).toBeNull();
    expect(store.previousSnapshot).toBeNull();
  });
});
