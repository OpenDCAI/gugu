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
  const pages = new ExtensionTaskPages(() => {}, async () => native); instances.push(pages);
  const a = new AbortController(), b = new AbortController();
  const caller = (controller: AbortController) => ({ kind: 'program', pageId: -811, extensionId: 'shared-app',
    callingSession: 'shared-task', signal: controller.signal, interruption: controller.signal, hear: vi.fn() }) as unknown as BridgeCaller;
  return { pages, native, a, b, caller, completeA, completeB };
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
