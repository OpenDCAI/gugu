import { afterEach, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { ExtensionTaskPages, type TaskPageNative } from './extension-task-pages';
import { cancelExtensionSessionCalls, revokeExtensionProgramAccess } from './extension-program-access';

const instances: ExtensionTaskPages[] = [];
afterEach(async () => { for (const pages of instances.splice(0)) await pages.closeProgram(-1); });
function caller(extensionId = 'app-a', session = 'task-a', pageId = -1) {
  const controller = new AbortController();
  const from = { kind: 'program', extensionId, pageId, callingSession: session, signal: controller.signal, hear: vi.fn() } as unknown as BridgeCaller;
  return { from, controller };
}
function native() {
  const messages = new Set<(method: string, params: Record<string, unknown>, session?: string) => void>();
  const closures = new Set<(reason: string) => void>();
  const value: TaskPageNative = { projectId: 'project-a', title: 'A page', url: 'https://example.org',
    protocol: { attached: false, send: vi.fn(async () => ({ result: 1 })),
      onMessage: fn => { messages.add(fn); return () => { messages.delete(fn); }; },
      onClose: fn => { closures.add(fn); return () => { closures.delete(fn); }; },
      close: vi.fn(reason => { for (const fn of closures) fn(reason!); }), },
    setActive: vi.fn(), release: vi.fn() };
  return { value, messages, closures };
}
function setup(choose: ConstructorParameters<typeof ExtensionTaskPages>[1] = async () => native().value) {
  const authorize = vi.fn();
  const select = vi.fn(choose);
  const pages = new ExtensionTaskPages(authorize, select);
  instances.push(pages);
  return { pages, select, authorize };
}
it('unmounting a page with no mounted lease is a no-op, including an omitted lease id', () => {
  const { pages } = setup();
  const page = { kind: 'page', pageId: 340, extensionId: 'app-a' } as unknown as BridgeCaller;
  expect(() => pages.unmount(page, undefined)).not.toThrow();
  expect(() => pages.unmount(page, 'previous-lease')).not.toThrow();
});
it('derives the selected task from its live call and restricts each opaque lease to its App/program/task', async () => {
  const page = native();
  const { pages, select } = setup(vi.fn(async () => page.value));
  const { from } = caller();
  const lease = await pages.acquire(from, { watchId: 'watch', sessionId: 'forged-task', webContentsId: 88, partition: 'forged-profile' });
  expect(select).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'task-a' }));
  for (const wrong of [caller('app-b').from, caller('app-a', 'task-b').from, caller('app-a', 'task-a', -2).from,
    { ...from, kind: 'page' }, { ...from, signal: undefined }]) {
    await expect(pages.send(wrong as BridgeCaller, { id: lease.id, method: 'Runtime.enable' })).rejects.toThrow();
  }
  await expect(pages.send(from, { id: '88', method: 'Runtime.enable' })).rejects.toThrow();
  expect(page.value.protocol.send).not.toHaveBeenCalled();
});
it('does not attach before acquisition is returned; commands and events use only the leased protocol', async () => {
  const page = native();
  const { pages } = setup(vi.fn(async () => page.value));
  const { from } = caller();
  const lease = await pages.acquire(from, { watchId: 'watch' });
  expect(page.messages.size).toBe(0);
  await expect(pages.send(from, { id: lease.id, method: 'Runtime.enable', params: {} })).resolves.toEqual({ result: 1 });
  expect(page.value.protocol.send).toHaveBeenCalledWith('Runtime.enable', {}, undefined, from.signal);
  expect(page.value.setActive).toHaveBeenNthCalledWith(1, true);
  expect(page.value.setActive).toHaveBeenLastCalledWith(false);
  for (const receive of page.messages) receive('Page.loadEventFired', {});
  expect(from.hear).toHaveBeenCalledWith({ type: 'taskPage', event: { watchId: 'watch', type: 'message', method: 'Page.loadEventFired', params: {} } });
  await pages.release(from, lease.id);
  expect(page.value.release).toHaveBeenCalledTimes(1);
  expect(page.value.protocol.close).toHaveBeenCalledTimes(1);
});
it('keeps the person page leased across tool completion but revokes it on App permission withdrawal', async () => {
  const page = native();
  const { pages } = setup(vi.fn(async () => page.value));
  const { from, controller } = caller('revoked-page-app');
  const lease = await pages.acquire(from, { watchId: 'watch' });
  controller.abort();
  expect(page.value.release).not.toHaveBeenCalled();
  await expect(pages.send(from, { id: lease.id, method: 'Runtime.enable' })).rejects.toThrow();
  revokeExtensionProgramAccess('revoked-page-app');
  expect(page.value.release).toHaveBeenCalledTimes(1);
});
it('starts event delivery before resource-owned initialization without borrowing a tool call', async () => {
  const page = native();
  page.value.protocol.maintain = vi.fn(async () => {
    for (const receive of page.messages) receive('Target.attachedToTarget', { sessionId: 'child' });
    return {};
  });
  const { pages } = setup(async () => page.value);
  const { from } = caller();
  const lease = await pages.acquire(from, { watchId: 'maintenance-events' });
  const background = { ...from, signal: undefined, callingSession: undefined };
  await pages.maintain(background, { id: lease.id, method: 'Runtime.enable' });
  expect(from.hear).toHaveBeenCalledWith({ type: 'taskPage', event: {
    watchId: 'maintenance-events', type: 'message', method: 'Target.attachedToTarget', params: { sessionId: 'child' },
  } });
  await expect(pages.maintain(background, { id: lease.id, method: 'Runtime.evaluate' })).rejects.toThrow('not connection maintenance');
  expect(page.value.protocol.maintain).toHaveBeenCalledTimes(1);
});
it('releases a late acquisition after task cancellation, without publishing a usable handle', async () => {
  const late = Promise.withResolvers<TaskPageNative>();
  const page = native();
  const { pages } = setup(vi.fn(() => late.promise));
  const { from, controller } = caller();
  const pending = pages.acquire(from, { watchId: 'late' });
  controller.abort(); late.resolve(page.value);
  await expect(pending).rejects.toThrow();
  expect(page.value.release).toHaveBeenCalledTimes(1);
});
it('program exit fences pending restoration and waits for its late resource cleanup', async () => {
  const late = Promise.withResolvers<TaskPageNative>();
  const page = native();
  const { pages, select } = setup(vi.fn(() => late.promise));
  const pending = pages.acquire(caller().from, { watchId: 'late' });
  const failed = expect(pending).rejects.toThrow();
  let closed = false;
  const exit = pages.closeProgram(-1).then(() => { closed = true; });
  expect(select.mock.calls[0]![0].signal.aborted).toBe(true);
  await Promise.resolve(); expect(closed).toBe(false);
  late.resolve(page.value); await failed; await exit;
  expect(page.value.release).toHaveBeenCalledTimes(1);
});
it('archive and project deletion fence pending acquisitions even if the task later returns', async () => {
  for (const scope of [{ sessionId: 'task-a' }, { projectId: 'project-a' }]) {
    const late = Promise.withResolvers<TaskPageNative>();
    const page = native();
    const { pages } = setup(vi.fn(() => late.promise));
    const pending = pages.acquire(caller().from, { watchId: 'late' });
    pages.closeScope(scope); late.resolve(page.value);
    await expect(pending).rejects.toThrow();
    expect(page.value.release).toHaveBeenCalledTimes(1);
  }
});
it('finishes all cleanup steps even when a native release fails', async () => {
  const page = native();
  const { pages } = setup(vi.fn(async () => page.value));
  const { from } = caller();
  const lease = await pages.acquire(from, { watchId: 'watch' });
  vi.mocked(page.value.release).mockImplementation(() => { throw new Error('native cleanup'); });
  await expect(pages.release(from, lease.id)).rejects.toThrow('Task page cleanup failed');
  expect(from.hear).toHaveBeenCalledWith({ type: 'taskPage', event: { watchId: 'watch', type: 'closed', reason: 'Released by its App' } });
  await expect(pages.send(from, { id: lease.id, method: 'Runtime.enable' })).rejects.toThrow();
});
it('refuses unsupported URLs before selecting a task page', async () => {
  const { pages, select } = setup();
  for (const url of ['file:///etc/passwd', 'gugu-ext://app-a/index.html', 'chrome://settings']) {
    await expect(pages.acquire(caller().from, { watchId: 'watch', url })).rejects.toThrow('Invalid task page');
  }
  expect(select).not.toHaveBeenCalled();
});

it('allows teardown after call cancellation, but waits for held controls before releasing the page', async () => {
  const page = native(), released = Promise.withResolvers<void>();
  page.value.cleanup = vi.fn(() => released.promise);
  const { pages } = setup(async () => page.value);
  const { from, controller } = caller();
  const lease = await pages.acquire(from, { watchId: 'watch' });
  controller.abort();
  await expect(pages.send(from, { id: lease.id, method: 'Input.insertText' })).rejects.toThrow();
  const closing = pages.release(from, lease.id);
  expect(page.value.cleanup).toHaveBeenCalledTimes(1);
  expect(page.value.protocol.close).not.toHaveBeenCalled();
  let done = false;
  const exit = pages.closeProgram(-1).then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  released.resolve(); await closing; await exit;
  expect(page.value.protocol.close).toHaveBeenCalledTimes(1);
  expect(page.value.release).toHaveBeenCalledTimes(1);
});

it('task stop closes already returned leases without revoking another task’s App resource', async () => {
  const selected = [native(), native()]; let next = 0;
  const { pages } = setup(async () => selected[next++]!.value);
  const a = caller(), b = caller('app-a', 'task-b');
  await pages.acquire(a.from, { watchId: 'a' });
  const other = await pages.acquire(b.from, { watchId: 'b' });
  cancelExtensionSessionCalls('task-a');
  expect(selected[0]!.value.release).toHaveBeenCalledTimes(1);
  expect(selected[1]!.value.release).not.toHaveBeenCalled();
  await expect(pages.send(b.from, { id: other.id, method: 'Runtime.enable' })).resolves.toEqual({ result: 1 });
});

it('an individual MCP interruption keeps the returned lease until the task itself stops', async () => {
  const page = native(), stop = new AbortController(), completed = new AbortController();
  const { pages } = setup(async () => page.value);
  const from = { ...caller().from, signal: completed.signal, interruption: stop.signal };
  await pages.acquire(from, { watchId: 'watch' });
  completed.abort(); expect(page.value.release).not.toHaveBeenCalled();
  stop.abort(); expect(page.value.release).not.toHaveBeenCalled();
  cancelExtensionSessionCalls('task-a'); expect(page.value.release).toHaveBeenCalledTimes(1);
});

it('program exit observes failed late cleanup and still releases the other late page', async () => {
  const a = Promise.withResolvers<TaskPageNative>(), b = Promise.withResolvers<TaskPageNative>();
  const first = native(), second = native();
  vi.mocked(first.value.release).mockImplementation(() => { throw new Error('late native release failed'); });
  let next = 0;
  const report = vi.spyOn(console, 'error').mockImplementation(() => {});
  const { pages } = setup(() => next++ ? b.promise : a.promise);
  try {
    const pa = pages.acquire(caller().from, { watchId: 'a' }), pb = pages.acquire(caller().from, { watchId: 'b' });
    const failedA = expect(pa).rejects.toThrow('acquisition and cleanup failed'), failedB = expect(pb).rejects.toThrow();
    const exit = pages.closeProgram(-1), failedExit = expect(exit).rejects.toThrow('did not close cleanly');
    a.resolve(first.value); b.resolve(second.value);
    await failedA; await failedB; await failedExit;
    expect(first.value.protocol.close).toHaveBeenCalledTimes(1);
    expect(second.value.release).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(expect.objectContaining({ message: 'Late task page cleanup failed' }));
  } finally { report.mockRestore(); }
});
