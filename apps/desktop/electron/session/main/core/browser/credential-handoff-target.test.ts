import { EventEmitter } from 'node:events';
import type { BrowserWindow, WebContentsView } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { BrowserPageRuntime } from './browser-page-runtime';
import { prepareCredentialHandoffTarget } from './credential-handoff-target';
import type { CredentialUseBinding } from './credential-use-contract';

function target() {
  const contents = Object.assign(new EventEmitter(), { isDestroyed: () => false,
    loadURL: vi.fn(async (_url: string) => {}), setBackgroundThrottling() {}, stop() {},
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
});
