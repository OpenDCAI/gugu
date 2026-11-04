import { afterEach, expect, it, vi } from 'vitest';
import type { BridgeCaller } from './extension-bridge';
import { ExtensionAppSurfaces, type AppSurfaceNative } from './extension-app-surfaces';
import { closeProgramResources } from './program-resource-lifetime';
import { revokeExtensionProgramAccess } from './extension-program-access';
import { appSurfaceOptionsSchema, appSurfaceUpdateSchema } from '@shared/extensions/app-surface';
import { callRefusal } from '@shared/extensions/bridge-protocol';

const options = { entry: 'controls.html', bounds: { x: 10, y: 20, width: 200, height: 40 }, data: { paused: false } };
const caller = (app = 'surface-app', task = 'task-a') => ({ kind: 'program', pageId: -700, extensionId: app,
  callingSession: task, signal: new AbortController().signal, hear: vi.fn() }) as unknown as BridgeCaller;
const native = (): AppSurfaceNative => ({ pageId: 800, shown: () => true, update: vi.fn(), close: vi.fn() });
afterEach(async () => { await closeProgramResources(-700); });

it('fixes decorative mode at creation and refuses updates, input handlers and focus requests', async () => {
  expect(appSurfaceOptionsSchema.parse(options)).toMatchObject({ decorative: false });
  const from = caller(), view = native(), create = vi.fn(async () => view);
  const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', create, vi.fn());
  const result = surfaces.open(from, { ...options, decorative: true });
  await new Promise(resolve => setImmediate(resolve));
  expect(create).toHaveBeenCalledWith(expect.objectContaining({ options: expect.objectContaining({ decorative: true }) }));
  surfaces.update(from, result.id, { data: { frame: 1, decorative: false } });
  for (const change of [{ decorative: false }, { decorative: true }, { mousePassthrough: false }, { focus: true }, { onInput: 'callback' }]) {
    expect(() => appSurfaceUpdateSchema.parse(change)).toThrow();
    expect(() => surfaces.update(from, result.id, change)).toThrow();
  }
  for (const extra of [{ focus: true }, { keyboard: true }, { onInput: 'callback' }]) {
    expect(() => surfaces.open(from, { ...options, decorative: true, ...extra })).toThrow();
  }
  const page = { kind: 'page', pageId: 800, extensionId: from.extensionId, binding: { workspace: 'session:task-a' } } as BridgeCaller;
  expect(() => surfaces.post(page, { action: 'forged-input' })).toThrow('decorative');
  const authority = { kind: 'page' as const, gesture: true, has: () => true, widget: false, decorative: true };
  for (const method of ['appSurfacePost', 'modalOpen', 'modalKey', 'projectionSend', 'taskMessage', 'showSession', 'openLink']) {
    expect(callRefusal(method, {}, authority), method).toMatchObject({ code: 'denied' });
  }
  expect(callRefusal('getContext', {}, authority)).toBeNull();
});

it('returns before native display, including an indefinitely pending display', async () => {
  const pending = Promise.withResolvers<AppSurfaceNative>(), entered = Promise.withResolvers<void>();
  const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', () => { entered.resolve(); return pending.promise; }, vi.fn());
  const from = caller();
  const result = surfaces.open(from, options);
  expect(result).toEqual({ id: expect.any(String), shown: false });
  await entered.promise;
  surfaces.update(from, result.id, { data: { paused: true } });
  const view = native(); pending.resolve(view);
  await new Promise(resolve => setImmediate(resolve));
  expect(view.update).toHaveBeenCalledWith(expect.objectContaining({ bounds: options.bounds, data: { paused: true } }));
  expect(from.hear).toHaveBeenCalledWith({ type: 'appSurface', event: { id: result.id, type: 'display', shown: true } });
});
it('reports display failure without turning it into a call/action failure', async () => {
  const report = vi.fn(), from = caller();
  const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', async () => { throw new Error('window unavailable'); }, report);
  const result = surfaces.open(from, options);
  await new Promise(resolve => setImmediate(resolve));
  expect(from.hear).toHaveBeenCalledWith({ type: 'appSurface', event: { id: result.id, type: 'display', shown: false, reason: 'display-unavailable' } });
  expect(report).toHaveBeenCalledTimes(1);
  expect(() => surfaces.update(from, result.id, { data: {} })).toThrow('not owned');
});
it('normal tool completion permits a slow display, while actual interruption cancels it', async () => {
  for (const interrupted of [false, true]) {
    const completed = new AbortController(), stop = new AbortController();
    const late = Promise.withResolvers<AppSurfaceNative>(), entered = Promise.withResolvers<void>(), view = native();
    const from = { ...caller(), signal: completed.signal, interruption: stop.signal };
    const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', () => { entered.resolve(); return late.promise; }, vi.fn());
    surfaces.open(from, options); await entered.promise;
    completed.abort(); if (interrupted) stop.abort();
    late.resolve(view); await new Promise(resolve => setImmediate(resolve));
    expect(view.close).toHaveBeenCalledTimes(interrupted ? 1 : 0);
    // Cleanup the successful display using the program lifetime, not a completed tool context.
    await closeProgramResources(-700);
  }
});
it('does not let another App/task/program update a display or impersonate its buttons', async () => {
  const from = caller(), view = native();
  const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', async () => view, vi.fn());
  const result = surfaces.open(from, options);
  await new Promise(resolve => setImmediate(resolve));
  for (const other of [caller('other'), caller('surface-app', 'task-b'), { ...from, pageId: -701 }]) {
    expect(() => surfaces.update(other, result.id, { data: {} })).toThrow();
  }
  const page = { kind: 'page', pageId: 800, extensionId: from.extensionId, binding: { workspace: 'session:task-a' } } as BridgeCaller;
  surfaces.post(page, { button: 'app-defined' });
  expect(from.hear).toHaveBeenCalledWith({ type: 'appSurface', event: { id: result.id, type: 'message', message: { button: 'app-defined' } } });
  expect(() => surfaces.post({ ...page, pageId: 801 }, { button: 'forged' })).toThrow();
});
it('closes on withdrawal and rejects late windows after program exit', async () => {
  const from = caller('revoked-surface'), view = native();
  const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', async () => view, vi.fn());
  surfaces.open(from, options); await new Promise(resolve => setImmediate(resolve));
  revokeExtensionProgramAccess('revoked-surface'); expect(view.close).toHaveBeenCalledTimes(1);
  const late = Promise.withResolvers<AppSurfaceNative>(), entered = Promise.withResolvers<void>();
  const second = new ExtensionAppSurfaces(() => {}, async () => 'project-a', () => { entered.resolve(); return late.promise; }, vi.fn());
  second.open(caller(), options); await entered.promise;
  const exiting = closeProgramResources(-700);
  const old = native(); late.resolve(old); await exiting;
  expect(old.close).toHaveBeenCalledTimes(1);
});
it('rejects bundle escapes and invalid bounds before opening a native window', () => {
  const create = vi.fn();
  const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', create, vi.fn());
  for (const entry of ['../host.html', 'https://example.org', 'controls.html?x=1']) expect(() => surfaces.open(caller(), { ...options, entry })).toThrow();
  expect(() => surfaces.open(caller(), { ...options, bounds: { ...options.bounds, width: Infinity } })).toThrow();
  expect(create).not.toHaveBeenCalled();
});

it('closing after interruption still waits for a late native result during program shutdown', async () => {
  const late = Promise.withResolvers<AppSurfaceNative>(), entered = Promise.withResolvers<void>();
  const surfaces = new ExtensionAppSurfaces(() => {}, async () => 'project-a', () => { entered.resolve(); return late.promise; }, vi.fn());
  const stop = new AbortController(), from = { ...caller(), signal: stop.signal };
  const result = surfaces.open(from, options); await entered.promise;
  stop.abort();
  expect(() => surfaces.release(from, result.id)).not.toThrow();
  let done = false;
  const exit = closeProgramResources(-700).then(() => { done = true; });
  await Promise.resolve(); expect(done).toBe(false);
  const view = native(); late.resolve(view); await exit;
  expect(view.close).toHaveBeenCalledTimes(1);
});
