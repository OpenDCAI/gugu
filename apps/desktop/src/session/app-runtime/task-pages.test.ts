import { afterEach, expect, it, vi } from 'vitest';
import { mountTaskPage, taskPagesApi } from './task-pages';
import type { TaskPageEvent, TaskPageHost, TaskPagePresentation } from '@shared/extensions/task-page-protocol';

afterEach(() => { vi.unstubAllGlobals(); });
it('forwards file cards through its own lease only and rejects a late payload after close', async () => {
  let receive: (event: TaskPageEvent) => void = () => {}, watch = '';
  const pending = Promise.withResolvers<[]>(), filePayloads = vi.fn(() => pending.promise);
  const host: TaskPageHost = { onTaskPage: fn => { receive = fn; return () => {}; }, pages: {
    acquire: async ({ watchId }) => { watch = watchId; return { id: 'own-lease', title: '', url: '' }; },
    filePayloads, send: vi.fn(), release: vi.fn(), mount: vi.fn(), unmount: vi.fn(),
  } };
  const lease = await taskPagesApi(host).acquire(), refs = [{ file: 'card-id', expectedVersion: 2 }];
  const work = lease.filePayloads(refs), rejected = expect(work).rejects.toThrow('task stopped');
  expect(filePayloads).toHaveBeenCalledExactlyOnceWith({ id: 'own-lease', refs });
  receive({ watchId: watch, type: 'closed', reason: 'task stopped' }); pending.resolve([]); await rejected;
  await expect(lease.filePayloads(refs)).rejects.toThrow('task stopped'); expect(filePayloads).toHaveBeenCalledTimes(1);
});
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

it('keeps geometry events separate from protocol messages and clears decoration on close without accepting late events', async () => {
  let receive: (event: TaskPageEvent) => void = () => {};
  let watch = '';
  const host: TaskPageHost = { onTaskPage: fn => { receive = fn; return () => {}; }, pages: {
    acquire: vi.fn(async ({ watchId }) => { watch = watchId; return { id: 'lease', title: 'Page', url: 'https://example.org' }; }),
    presentation: vi.fn(async () => null), send: vi.fn(), release: vi.fn(), mount: vi.fn(), unmount: vi.fn(),
  } };
  const lease = await taskPagesApi(host).acquire(), geometry = vi.fn(), protocol = vi.fn();
  lease.onPresentation(geometry); lease.onMessage(protocol);
  await expect(lease.presentation()).resolves.toBeNull();
  expect(host.pages!.presentation).toHaveBeenCalledExactlyOnceWith({ id: 'lease' });
  receive({ watchId: 'other-lease', type: 'presentation', presentation: null }); expect(geometry).not.toHaveBeenCalled();
  receive({ watchId: watch, type: 'presentation', presentation: null });
  expect(geometry).toHaveBeenCalledExactlyOnceWith(null); expect(protocol).not.toHaveBeenCalled();
  await lease.close(); expect(geometry).toHaveBeenCalledTimes(2);
  receive({ watchId: watch, type: 'presentation', presentation: null }); expect(geometry).toHaveBeenCalledTimes(2);
  await expect(lease.presentation()).rejects.toThrow('Released');
});

it('does not let a late geometry reply override a newer hidden state or revive a closed lease', async () => {
  let receive: (event: TaskPageEvent) => void = () => {}, watch = '';
  const pending = Promise.withResolvers<TaskPagePresentation | null>();
  const measure = vi.fn(() => pending.promise);
  const host: TaskPageHost = { onTaskPage: fn => { receive = fn; return () => {}; }, pages: {
    acquire: async ({ watchId }) => { watch = watchId; return { id: 'lease', title: 'Page', url: '' }; },
    presentation: measure, send: vi.fn(), release: vi.fn(), mount: vi.fn(), unmount: vi.fn(),
  } };
  const lease = await taskPagesApi(host).acquire();
  const geometry = { space: 'screen-dip' as const, bounds: { x: 10, y: 20, width: 30, height: 40 },
    clip: { x: 10, y: 20, width: 30, height: 40 }, zoomFactor: 1, relativeTo: { windowId: '10' } };
  const late = Promise.withResolvers<typeof geometry>();
  measure.mockImplementationOnce(() => late.promise);
  const snapshot = lease.presentation();
  receive({ watchId: watch, type: 'presentation', presentation: null });
  late.resolve(geometry); await expect(snapshot).resolves.toBeNull();
  const afterClose = lease.presentation(), rejected = expect(afterClose).rejects.toThrow('Released');
  await lease.close(); pending.resolve(null); await rejected;
});
