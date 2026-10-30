import { describe, expect, it, vi } from 'vitest';
import { createProjectionDeviceRuntime } from '../../../../apps/desktop/electron/projection-device-runtime';
import type { ProjectionViewerPage } from '../../../../apps/desktop/electron/projection-device-client';

const fixture = () => {
  const report = vi.fn(), openPipe = vi.fn(async () => { throw new Error('Unexpected transport'); });
  const runtime = createProjectionDeviceRuntime({ auth: async () => ({ userId: 'owner', accessToken: 'fixture' }),
    runtime: () => ({ ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'instance' }),
    resources: () => '/projection-fixture-artifacts-do-not-exist', report, openPipe,
    capturePage: async () => { throw new Error('Unexpected page'); } });
  return { runtime, report, openPipe };
};
describe('actual outer projection runtime ownership', () => {
  it('invalidates its actual leases synchronously and fails closed without host-owned media artifacts', async () => {
    const f = fixture();
    try {
      const lease = await f.runtime.options.identity.capture(new AbortController().signal);
      expect(() => f.runtime.options.executables()).toThrow(/not installed/);
      f.runtime.invalidate(); expect(lease.signal.aborted).toBe(true);
      await f.runtime.dispose();
      await expect(f.runtime.openViewer(7)).rejects.toThrow(/unavailable/);
      expect(f.openPipe).not.toHaveBeenCalled();
    } finally { await f.runtime.dispose(); }
  });
  it('observes disposal once, awaits physical completion, and reports cleanup failure', async () => {
    const f = fixture(); let finish!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const failure = new Error('Physical helper exit failed'), dispose = vi.fn(async () => { await gate; throw failure; });
    const owned = f.runtime.track({ dispose });
    const closing = owned.dispose()!.then(() => undefined, error => error);
    let settled = false;
    const stopped = f.runtime.dispose().then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      await new Promise(resolve => setImmediate(resolve)); expect(settled).toBe(false); expect(dispose).toHaveBeenCalledTimes(1);
    } finally { finish(); }
    expect(await closing).toBe(failure); expect(await stopped).toBe(failure); expect(f.report).toHaveBeenCalledWith(failure);
  });
  it('releases a late page capture after shutdown without creating a requester', async () => {
    let capture!: (page: ProjectionViewerPage) => void;
    const gate = new Promise<ProjectionViewerPage>(resolve => { capture = resolve; });
    const release = vi.fn(), openPipe = vi.fn(async () => { throw new Error('Late transport opened'); });
    const runtime = createProjectionDeviceRuntime({ auth: async () => null, runtime: () => null, resources: () => '', report: vi.fn(),
      capturePage: () => gate, openPipe });
    const opening = runtime.openViewer(7).then(() => undefined, error => error);
    await runtime.dispose();
    capture({ id: '7', epoch: 1, appId: 'app', version: '1', sessionId: 'task', deviceId: 'remote',
      signal: new AbortController().signal, assertCurrent() {}, release });
    expect((await opening).message).toMatch(/stopped/); expect(release).toHaveBeenCalledTimes(1); expect(openPipe).not.toHaveBeenCalled();
  });
});
