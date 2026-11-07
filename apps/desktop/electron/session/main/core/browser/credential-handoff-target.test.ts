import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { BrowserPageRuntime } from './browser-page-runtime';
import { prepareCredentialHandoffTarget, prepareFreshCredentialHandoffTarget } from './credential-handoff-target';
import type { CredentialUseBinding } from './credential-use-contract';

function target() {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    loadURL: vi.fn(async (_url: string) => {}), setBackgroundThrottling() {}, stop() {},
    navigationHistory: { canGoBack: () => true, canGoForward: () => true, goBack: vi.fn(), goForward: vi.fn() },
    endFrameSubscription() {}, close() { contents.emit('destroyed'); } });
  const view = { webContents: contents, setBounds() {}, setVisible() {} };
  const runtime = new BrowserPageRuntime(view as unknown as WebContentsView);
  const host = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} } };
  runtime.moveTo(host as unknown as BrowserWindow);
  return { contents, runtime, host };
}
const binding = { origin: 'https://login.example.test:8443' } as CredentialUseBinding;

describe('native credential handoff destination', () => {
  it('dispatches loadURL synchronously after the final identity check and consumes the prepared navigation once', async () => {
    const { runtime, contents } = target(), guard = vi.fn();
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, binding, guard);
      expect(contents.loadURL).not.toHaveBeenCalled();
      const loading = prepared.commit();
      expect(guard).toHaveBeenCalledTimes(2);
      expect(contents.loadURL).toHaveBeenCalledWith(binding.origin);
      expect(guard.mock.invocationCallOrder[1]).toBeLessThan(contents.loadURL.mock.invocationCallOrder[0]);
      await loading;
      expect(() => prepared.commit()).toThrow('invalidated');
      expect(contents.loadURL).toHaveBeenCalledOnce();
    } finally { runtime.close(); }
  });

  it('refuses changed identity after async preparation and dispatches zero native navigations', async () => {
    const { runtime, contents } = target();
    let current = true;
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, binding, () => { if (!current) throw new Error('invalidated'); });
      current = false;
      expect(() => prepared.commit()).toThrow('invalidated');
      expect(contents.loadURL).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });

  it('refuses a destination replaced by another navigation instead of navigating the stale tab intent', async () => {
    const { runtime, contents } = target();
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, binding, () => {});
      await runtime.navigate('https://other.example.test/');
      expect(() => prepared.commit()).toThrow('invalidated');
      expect(contents.loadURL.mock.calls).toEqual([['https://other.example.test/']]);
    } finally { runtime.close(); }
  });

  it('cannot turn a full redirected URL/query into the handoff destination', async () => {
    const { runtime, contents } = target();
    try {
      await expect(prepareCredentialHandoffTarget(runtime, { ...binding, origin: binding.origin + '/echo?private=value' }, () => {})).rejects.toThrow();
      expect(contents.loadURL).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });

  it('captures the reviewed origin rather than a mutable caller URL', async () => {
    const { runtime, contents } = target(), mutable = { ...binding };
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, mutable, () => {});
      mutable.origin = 'https://other.example.test';
      await prepared.commit();
      expect(contents.loadURL.mock.calls).toEqual([[binding.origin]]);
    } finally { runtime.close(); }
  });

  it.each(['stop', 'reload', 'prepare'] as const)('refuses a prepared handoff superseded by %s', async action => {
    const { runtime, contents } = target();
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, binding, () => {});
      if (action === 'prepare') await runtime.prepareNavigation('https://other.example.test/');
      else if (action === 'reload') await runtime.reload();
      else runtime.stop();
      expect(() => prepared.commit()).toThrow('invalidated');
      expect(contents.loadURL.mock.calls.some(([url]) => url === binding.origin)).toBe(false);
    } finally { runtime.close(); }
  });

  it.each(['goBack', 'goForward'] as const)('invalidates synchronously before native %s even before a navigation event arrives', async action => {
    const { runtime, contents } = target();
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, binding, () => {});
      runtime[action]();
      expect(contents.navigationHistory[action]).toHaveBeenCalledOnce();
      expect(() => prepared.commit()).toThrow('invalidated');
      expect(contents.loadURL).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });

  it.each(['did-start-navigation', 'did-navigate', 'did-navigate-in-page'])('rejects prepared commit after native top-level %s', async event => {
    const { runtime, contents } = target();
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, binding, () => {});
      if (event === 'did-start-navigation') contents.emit(event, { isMainFrame: true });
      else if (event === 'did-navigate-in-page') contents.emit(event, {}, 'https://other.example.test/#new', true);
      else contents.emit(event, {}, 'https://other.example.test/');
      expect(() => prepared.commit()).toThrow('invalidated');
      expect(contents.loadURL).not.toHaveBeenCalled();
    } finally { runtime.close(); }
  });

  it('does not invalidate top-level handoff from an unrelated subframe event', async () => {
    const { runtime, contents } = target();
    try {
      const prepared = await prepareCredentialHandoffTarget(runtime, binding, () => {});
      contents.emit('did-start-navigation', { isMainFrame: false });
      contents.emit('did-navigate-in-page', {}, 'https://frame.example.test/#new', false);
      await prepared.commit();
      expect(contents.loadURL).toHaveBeenCalledWith(binding.origin);
    } finally { runtime.close(); }
  });
});

describe('fresh unregistered credential destination', () => {
  function port() {
    const destination = { loadOrigin: vi.fn(async (_origin: string) => {}),
      publish: vi.fn(() => ({ status: 'published' as const })), retract: vi.fn(() => {}), confirm: vi.fn(() => {}), dispose: vi.fn(async () => {}) };
    const value = { assertCurrent: vi.fn((_binding: CredentialUseBinding) => {}), prepare: vi.fn(async () => destination) };
    return { destination, value };
  }

  it('loads only the safe origin while unpublished, then publishes synchronously once', async () => {
    const f = port();
    const prepared = await prepareFreshCredentialHandoffTarget(binding, f.value);
    expect(f.destination.loadOrigin).toHaveBeenCalledWith(binding.origin);
    expect(f.destination.publish).not.toHaveBeenCalled();
    const result = prepared.commit();
    expect(f.destination.publish).toHaveBeenCalledOnce();
    expect(f.destination.confirm.mock.calls.length).toBe(0);
    await result;
    prepared.confirm();
    expect(f.destination.confirm.mock.calls.length).toBe(1);
    await prepared.discard();
    expect(f.destination.dispose.mock.calls.length).toBe(0);
    expect(() => prepared.commit()).toThrow('credential_handoff_unavailable');
  });

  it('does not publish when invalidated while the fresh target is loading', async () => {
    const f = port();
    let resolve!: () => void, current = true;
    const loading = new Promise<void>(done => { resolve = done; });
    f.destination.loadOrigin.mockReturnValueOnce(loading);
    f.value.assertCurrent.mockImplementation(() => { if (!current) throw new Error('invalidated'); });
    const preparing = prepareFreshCredentialHandoffTarget(binding, f.value);
    await Promise.resolve(); await Promise.resolve();
    current = false; resolve();
    await expect(preparing).rejects.toThrow('credential_handoff_unavailable');
    expect(f.destination.publish).not.toHaveBeenCalled();
    expect(f.destination.dispose).toHaveBeenCalledOnce();
  });

  it('discards prepared contexts without publishing from cleanup or a late callback', async () => {
    const f = port(), prepared = await prepareFreshCredentialHandoffTarget(binding, f.value);
    await prepared.discard(); await prepared.discard();
    expect(() => prepared.commit()).toThrow('credential_handoff_unavailable');
    expect(f.destination.publish).not.toHaveBeenCalled();
    expect(f.destination.dispose).toHaveBeenCalledOnce();
  });

  it('does not turn an uncertain publication result into a success or a retry', async () => {
    const f = port();
    f.destination.publish.mockImplementationOnce(() => { throw new Error('synthetic_native_publish_failure'); });
    const prepared = await prepareFreshCredentialHandoffTarget(binding, f.value);
    expect(() => prepared.commit()).toThrow('credential_handoff_unavailable');
    await prepared.discard();
    expect(() => prepared.commit()).toThrow('credential_handoff_unavailable');
    expect(f.destination.publish).toHaveBeenCalledOnce();
    expect(f.destination.dispose).toHaveBeenCalledOnce();
  });

  it('retracts a published but unconfirmed target before waiting for its actual disposal', async () => {
    const f = port(), prepared = await prepareFreshCredentialHandoffTarget(binding, f.value);
    await prepared.commit();
    const disposal = prepared.discard();
    expect(f.destination.retract.mock.calls.length).toBe(1);
    expect(f.destination.dispose.mock.calls.length).toBe(1);
    expect(() => prepared.confirm()).toThrow('credential_handoff_unavailable');
    await disposal;
  });

  it('still attempts disposal when the synchronous retraction reports a failure', async () => {
    const f = port(), prepared = await prepareFreshCredentialHandoffTarget(binding, f.value);
    f.destination.retract.mockImplementationOnce(() => { throw new Error('retraction_unconfirmed'); });
    await prepared.discard();
    expect(f.destination.dispose.mock.calls.length).toBe(1);
    expect(() => prepared.commit()).toThrow('credential_handoff_unavailable');
  });
});
