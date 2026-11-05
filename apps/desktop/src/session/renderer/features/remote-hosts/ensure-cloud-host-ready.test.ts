// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUD_COMPUTER_WAKE_TIMEOUT_MS } from '@gugu/core/cloud/cloudComputer';
import { installRemoteHostsBridge, CloudComputerWakeFailed, type RemoteHostDevice } from '@/session/shared/remote-hosts';
import { machineRegistry } from '@renderer/lib/machine-routing';
import { ensureProjectHostReady } from './ensure-cloud-host-ready';

afterEach(() => { vi.useRealTimers(); machineRegistry.forgetMachine('cloud-ready-device'); });

function fixture() {
  machineRegistry.register('cloud-ready-device', ['cloud-ready-project']);
  let device = { id: 'cloud-ready-device', label: 'Assistant', isOnline: true, cloudComputer: 'asleep', assistantHome: true } as RemoteHostDevice;
  const listeners = new Set<() => void>();
  const wake = vi.fn(async () => {});
  const off = installRemoteHostsBridge({ listDevices: () => [device],
    subscribeDevices: listener => (listeners.add(listener), () => { listeners.delete(listener); }),
    wakeCloudComputer: wake, pickFolder: async () => null });
  return { wake, off, listeners, update(next: Partial<RemoteHostDevice>) { device = { ...device, ...next }; listeners.forEach(listener => listener()); } };
}

describe('explicit cloud project operation readiness', () => {
  it('waits for awake AND heartbeat in the RPC bridge, even when the wake request has returned', async () => {
    const f = fixture();
    try {
      let done = false;
      const ready = ensureProjectHostReady('cloud-ready-project').then(() => { done = true; });
      await Promise.resolve();
      expect(f.wake).toHaveBeenCalledExactlyOnceWith('cloud-ready-device');
      expect(done).toBe(false);
      f.update({ cloudComputer: 'awake', isOnline: false });
      await Promise.resolve();
      expect(done).toBe(false);
      f.update({ isOnline: true });
      await ready;
      expect(done).toBe(true);
      expect(f.listeners.size).toBe(0);
      // Confirmation may have been left open until this host went back to sleep.
      f.update({ cloudComputer: 'asleep' });
      const again = ensureProjectHostReady('cloud-ready-project');
      await Promise.resolve();
      f.update({ cloudComputer: 'awake' });
      await again;
      expect(f.wake).toHaveBeenCalledTimes(2);
    } finally { f.off(); }
  });

  it('preserves membership refusal and controller failure without continuing to RPC', async () => {
    const f = fixture();
    try {
      for (const failure of [new CloudComputerWakeFailed('refused', 'credits_exhausted', 'credits exhausted'), new CloudComputerWakeFailed('failed', 'unavailable', 'controller unavailable')]) {
        f.wake.mockRejectedValueOnce(failure);
        await expect(ensureProjectHostReady('cloud-ready-project')).rejects.toBe(failure);
      }
      expect(f.listeners.size).toBe(0);
    } finally { f.off(); }
  });

  it('does not wake local or ordinary remote projects, including a host named Assistant', async () => {
    const f = fixture();
    try {
      f.update({ cloudComputer: undefined, assistantHome: undefined });
      await ensureProjectHostReady('cloud-ready-project');
      await ensureProjectHostReady('local-project');
      expect(f.wake).not.toHaveBeenCalled();
    } finally { f.off(); }
  });

  it('ends a missing projection at the wake deadline and cancels it on account bridge removal', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pending = expect(ensureProjectHostReady('cloud-ready-project')).rejects.toMatchObject({ reason: 'timeout' });
    await vi.advanceTimersByTimeAsync(CLOUD_COMPUTER_WAKE_TIMEOUT_MS);
    await pending;
    expect(f.listeners.size).toBe(0);
    const changed = expect(ensureProjectHostReady('cloud-ready-project')).rejects.toMatchObject({ code: 'signed_out' });
    await Promise.resolve();
    f.off();
    await changed;
    expect(f.listeners.size).toBe(0);
  });
});
