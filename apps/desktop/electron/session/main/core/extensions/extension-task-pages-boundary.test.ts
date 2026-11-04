import { afterEach, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { ExtensionTaskPages, type TaskPageNative } from './extension-task-pages';
import { cancelExtensionSessionCalls } from './extension-program-access';

const instances: ExtensionTaskPages[] = [];
afterEach(async () => { for (const pages of instances.splice(0)) await pages.closeProgram(-811); });
function setup() {
  const completeA = Promise.withResolvers<unknown>(), completeB = Promise.withResolvers<unknown>();
  const native: TaskPageNative = { projectId: 'project', title: 'Page', url: 'https://example.test',
    protocol: { attached: true, onMessage: () => () => {}, onClose: () => () => {}, close: vi.fn(),
      send: vi.fn(async (_method: string, params?: Record<string, unknown>, _session?: string, signal?: AbortSignal) => {
        const work = params?.call === 'a' ? completeA.promise : completeB.promise;
        return new Promise((resolve, reject) => {
          const abort = () => reject(signal?.reason);
          signal?.addEventListener('abort', abort, { once: true });
          work.then(resolve, reject).finally(() => signal?.removeEventListener('abort', abort));
          if (signal?.aborted) abort();
        });
      }) }, setActive: vi.fn(), release: vi.fn() };
  const report = vi.fn();
  const pages = new ExtensionTaskPages(() => {}, async () => native, report); instances.push(pages);
  const a = new AbortController(), b = new AbortController();
  const caller = (controller: AbortController) => ({ kind: 'program', pageId: -811, extensionId: 'shared-app',
    callingSession: 'shared-task', signal: controller.signal, interruption: controller.signal, hear: vi.fn() }) as unknown as BridgeCaller;
  return { pages, native, a, b, caller, completeA, completeB, report };
}

it('denies native file-input attachment before dispatch even with agents:tools and a live task call', async () => {
  const { pages, native, a, caller } = setup();
  vi.mocked(native.protocol.send).mockResolvedValueOnce({ attached: true });
  const lease = await pages.acquire(caller(a), { watchId: 'files' });
  await expect(pages.send(caller(a), { id: lease.id, method: 'DOM.setFileInputFiles',
    params: { files: ['/private/owned-fixture.txt'], objectId: 'input' } })).rejects.toThrow(/file/i);
  expect(native.protocol.send).not.toHaveBeenCalled();
});

it('cancels concurrent A while keeping its returned shared lease and in-flight B usable', async () => {
  const { pages, native, a, b, caller, completeA, completeB } = setup();
  const lease = await pages.acquire(caller(a), { watchId: 'shared' });
  const pendingA = pages.send(caller(a), { id: lease.id, method: 'Runtime.evaluate', params: { call: 'a' } });
  const failedA = expect(pendingA).rejects.toThrow();
  const pendingB = pages.send(caller(b), { id: lease.id, method: 'Runtime.evaluate', params: { call: 'b' } });
  a.abort(new Error('only A cancelled')); await failedA;
  expect(native.protocol.close).not.toHaveBeenCalled();
  expect(native.release).not.toHaveBeenCalled();
  completeB.resolve({ call: 'b', ok: true });
  await expect(pendingB).resolves.toEqual({ call: 'b', ok: true });
  await expect(pages.send(caller(b), { id: lease.id, method: 'Runtime.evaluate', params: { call: 'b' } })).resolves.toEqual({ call: 'b', ok: true });
  completeA.resolve({ late: 'a' });
  cancelExtensionSessionCalls('shared-task');
  expect(native.protocol.close).toHaveBeenCalledTimes(1);
  await expect(pages.send(caller(b), { id: lease.id, method: 'Runtime.enable' })).rejects.toThrow();
});

it('limits background maintenance to the owning program resource and keeps ordinary sends call-bound', async () => {
  const { pages, native, a, caller } = setup();
  native.protocol.maintain = vi.fn(async () => ({ initialized: true }));
  const lease = await pages.acquire(caller(a), { watchId: 'maintenance' });
  a.abort();
  const background = { ...caller(new AbortController()), callingSession: undefined, signal: undefined, interruption: undefined };
  const command = { id: lease.id, method: 'Runtime.enable' };
  await expect(pages.maintain(background, command)).resolves.toEqual({ initialized: true });
  await expect(pages.send(background, command)).rejects.toThrow('current task');
  for (const wrong of [{ ...background, extensionId: 'other-app' }, { ...background, pageId: -812 },
    { ...background, kind: 'page' }, { ...background, callingSession: 'other-task' }]) {
    await expect(pages.maintain(wrong as BridgeCaller, command)).rejects.toThrow();
  }
  cancelExtensionSessionCalls('shared-task');
  await expect(pages.maintain(background, command)).rejects.toThrow();
  expect(native.protocol.maintain).toHaveBeenCalledTimes(1);
});

it('measures only the owning program lease, including after acquisition A ends, and rejects foreign targets or a stopped task', async () => {
  const { pages, native, a, caller } = setup();
  const geometry = { space: 'screen-dip' as const, bounds: { x: 10, y: 20, width: 300, height: 200 },
    clip: { x: 10, y: 20, width: 300, height: 200 }, zoomFactor: 1.5, relativeTo: { windowId: '12' } };
  native.presentation = vi.fn(() => geometry);
  const lease = await pages.acquire(caller(a), { watchId: 'geometry' }); a.abort();
  const background = { ...caller(new AbortController()), signal: undefined, callingSession: undefined };
  expect(pages.presentation(background, { id: lease.id })).toEqual(geometry);
  for (const wrong of [{ ...background, extensionId: 'other-app' }, { ...background, pageId: -812 },
    { ...background, kind: 'page' }, { ...background, callingSession: 'other-task' }]) {
    expect(() => pages.presentation(wrong as BridgeCaller, { id: lease.id })).toThrow();
  }
  expect(() => pages.presentation(background, { id: 'guessed-native-id' })).toThrow();
  expect(() => pages.presentation(background, { id: lease.id, windowId: '13' })).toThrow('only its page lease');
  cancelExtensionSessionCalls('shared-task');
  expect(() => pages.presentation(background, { id: lease.id })).toThrow();
  expect(native.presentation).toHaveBeenCalledTimes(1);
});

it('tears down native presentation observers and ignores their late callback after the lease closes', async () => {
  const { pages, native, a, caller } = setup();
  const off = vi.fn(); let changed: (value: null) => void = () => {};
  native.onPresentation = vi.fn(listener => { changed = listener; return off; });
  const from = caller(a), lease = await pages.acquire(from, { watchId: 'geometry-events' });
  changed(null);
  expect(from.hear).toHaveBeenLastCalledWith({ type: 'taskPage', event: { watchId: 'geometry-events', type: 'presentation', presentation: null } });
  await pages.release(from, lease.id); const count = vi.mocked(from.hear).mock.calls.length;
  changed(null); expect(from.hear).toHaveBeenCalledTimes(count); expect(off).toHaveBeenCalledTimes(1);
});

it('keeps acquisition and commands working if optional presentation subscription fails', async () => {
  const { pages, native, a, caller, report } = setup(), offClose = vi.fn();
  native.protocol.onClose = () => offClose;
  native.onPresentation = () => { throw new Error('presentation registration failed'); };
  vi.mocked(native.protocol.send).mockResolvedValue({ ok: true });
  const from = caller(a), lease = await pages.acquire(from, { watchId: 'failed-observer' });
  expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'presentation registration failed' }));
  expect(from.hear).toHaveBeenCalledWith({ type: 'taskPage', event: { watchId: 'failed-observer', type: 'presentation', presentation: null } });
  await expect(pages.send(from, { id: lease.id, method: 'Runtime.enable' })).resolves.toEqual({ ok: true });
  expect(offClose).not.toHaveBeenCalled(); await pages.release(from, lease.id);
  expect(offClose).toHaveBeenCalledTimes(1); expect(native.release).toHaveBeenCalledTimes(1);
});
