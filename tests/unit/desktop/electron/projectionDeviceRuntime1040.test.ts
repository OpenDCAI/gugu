import { describe, expect, it, vi } from 'vitest';
import { createProjectionDeviceRuntime } from '../../../../apps/desktop/electron/projection-device-runtime';
import type { ProjectionViewerPage } from '../../../../apps/desktop/electron/projection-device-client';
import type { DeviceRpcPipeHandlers } from '@gugu/core/cloud/deviceRpcRequester';

const fixture = () => {
  const report = vi.fn(), openPipe = vi.fn(async () => { throw new Error('Unexpected transport'); });
  const runtime = createProjectionDeviceRuntime({ auth: async () => ({ userId: 'owner', accessToken: 'fixture' }),
    runtime: () => ({ ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'instance' }),
    resources: () => '/projection-fixture-artifacts-do-not-exist', report, openPipe,
    capturePage: async () => { throw new Error('Unexpected page'); } });
  return { runtime, report, openPipe };
};
describe('actual outer projection runtime ownership', () => {
  it.each([false, true])('shutdown owns pending bind cleanup and returns its failure=%s', async fail => {
    const bind = Promise.withResolvers<void>(), unbind = Promise.withResolvers<void>();
    const bound = Promise.withResolvers<void>(), cleaning = Promise.withResolvers<void>();
    const release = vi.fn(), close = vi.fn(), report = vi.fn();
    const runtime = createProjectionDeviceRuntime({ auth: async () => ({ userId: 'owner', accessToken: 'fixture' }),
      runtime: () => ({ ownerId: 'owner', deviceId: 'device', runtimeInstanceId: 'instance' }), resources: () => '', report,
      capturePage: async () => ({ id: '7', epoch: 1, appId: 'app', version: '1', sessionId: 'task', deviceId: 'remote',
        signal: new AbortController().signal, assertCurrent() {}, release }),
      openPipe: async (_device: string, _asker: string, handlers: DeviceRpcPipeHandlers) => ({ close, async send(raw) {
        const request = (raw as { payload: { type: string; request_id: string } }).payload;
        const reply = (result?: unknown, error?: { code: string; message: string }) => handlers.onMessage({
          type: `${request.type}:reply`, request_id: request.request_id, result, error });
        if (request.type === 'projection.hello') reply({ proof: 'fixture-proof', deviceId: 'remote' });
        else if (request.type === 'projection.bind') { bound.resolve(); await bind.promise; reply({ bindingId: 'binding', controlKey: 'A'.repeat(43) }); }
        else if (request.type === 'projection.unbind') { cleaning.resolve(); await unbind.promise;
          reply(undefined, fail ? { code: 'cleanup', message: 'Fixture driver disconnect failed' } : undefined); }
        else if (request.type === 'projection.goodbye') reply();
        else throw new Error('Unexpected projection RPC');
      } }),
    });
    const opening = runtime.openViewer(7).then(() => undefined, error => error);
    let settled = false;
    await bound.promise;
    const completion = runtime.dispose();
    const stopping = completion.then(() => { settled = true; }, error => { settled = true; return error; });
    try {
      await cleaning.promise; await new Promise(resolve => setImmediate(resolve));
      expect(settled).toBe(false); expect(close).not.toHaveBeenCalled(); expect(release).not.toHaveBeenCalled();
      unbind.resolve(); bind.resolve();
      const result = await stopping;
      if (fail) { expect(result.message).toMatch(/driver disconnect failed/); expect(report).toHaveBeenCalled(); }
      else expect(result).toBeUndefined();
      expect(close).toHaveBeenCalledTimes(1); expect(release).toHaveBeenCalledTimes(1);
      expect(await opening).toBeInstanceOf(Error); expect(runtime.dispose()).toBe(completion);
    } finally { bind.resolve(); unbind.resolve(); await opening; await stopping; await runtime.dispose().catch(() => {}); }
  });
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
  it('keeps an already-draining failure while another owned resource is still closing', async () => {
    const f = fixture(), failure = new Error('Earlier owned cleanup failed'), gate = Promise.withResolvers<void>();
    const fast = f.runtime.track({ dispose: async () => { throw failure; } });
    const failed = fast.dispose().then(() => undefined, error => error);
    f.runtime.track({ dispose: async () => { await gate.promise; } });
    const completion = f.runtime.dispose(); expect(f.runtime.dispose()).toBe(completion);
    const stopping = completion.then(() => undefined, error => error);
    try {
      expect(await failed).toBe(failure); gate.resolve();
      expect(await stopping).toBe(failure); expect(f.report).toHaveBeenCalledWith(failure);
      await expect(f.runtime.dispose()).rejects.toBe(failure);
    } finally { gate.resolve(); await stopping; await f.runtime.dispose().catch(() => {}); }
  });
});
