import { afterEach, expect, it, vi } from 'vitest';
import { mountTaskPage, taskPagesApi } from './task-pages';
import type { TaskPageEvent, TaskPageHost } from '@shared/extensions/task-page-protocol';

afterEach(() => { vi.unstubAllGlobals(); });
it('preserves an early close and forbids further input without losing the close reason', async () => {
  let receive: (event: TaskPageEvent) => void = () => {};
  const host: TaskPageHost = { onTaskPage: fn => { receive = fn; return () => {}; }, pages: {
    acquire: vi.fn(async ({ watchId }) => { receive({ watchId, type: 'closed', reason: 'task stopped' }); return { id: 'lease', title: 'Page', url: 'https://example.org' }; }),
    send: vi.fn(), release: vi.fn(), mount: vi.fn(), unmount: vi.fn(),
  } };
  await expect(taskPagesApi(host).acquire()).rejects.toThrow('task stopped');
  expect(host.pages!.send).not.toHaveBeenCalled();
});
it('keeps only the latest native layout behind an in-flight update and unmounts after it', async () => {
  let notify: () => void = () => {};
  const disconnect = vi.fn();
  vi.stubGlobal('ResizeObserver', class { constructor(changed: () => void) { notify = changed; } observe() {} disconnect = disconnect; });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  let x = 0;
  const element = { getBoundingClientRect: () => ({ x, y: 1, width: 200, height: 100 }) } as HTMLElement;
  const pending = Promise.withResolvers<void>();
  const mount = vi.fn(async () => {}), unmount = vi.fn(async () => {});
  const host = { pages: { mount, unmount } } as unknown as TaskPageHost;
  const view = await mountTaskPage(host, element, 'lease');
  mount.mockImplementationOnce(() => pending.promise);
  x = 1; notify();
  for (x = 2; x <= 100; x++) notify();
  expect(mount).toHaveBeenCalledTimes(2);
  pending.resolve(); await vi.waitFor(() => expect(mount).toHaveBeenCalledTimes(3));
  expect(mount).toHaveBeenLastCalledWith({ id: 'lease', rect: { x: 100, y: 1, width: 200, height: 100 } });
  await view.close(); await view.close();
  expect(unmount).toHaveBeenCalledTimes(1); expect(disconnect).toHaveBeenCalledTimes(1);
});
it('reports a later layout error and still releases the native mount', async () => {
  let notify: () => void = () => {};
  vi.stubGlobal('ResizeObserver', class { constructor(changed: () => void) { notify = changed; } observe() {} disconnect() {} });
  vi.stubGlobal('window', { addEventListener: vi.fn() });
  const mount = vi.fn(async () => {}), unmount = vi.fn(async () => {}), error = vi.fn();
  const host = { pages: { mount, unmount } } as unknown as TaskPageHost;
  await mountTaskPage(host, { getBoundingClientRect: () => ({ x: 0, y: 0, width: 1, height: 1 }) } as HTMLElement, 'lease', { error });
  mount.mockRejectedValueOnce(new Error('document changed')); notify();
  await vi.waitFor(() => expect(unmount).toHaveBeenCalledWith({ id: 'lease' }));
  expect(error).toHaveBeenCalledWith(expect.objectContaining({ message: 'document changed' }));
});
