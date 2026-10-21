import { EventEmitter } from 'node:events';
import type { BrowserWindow } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => state.windows },
  ipcMain: {},
}));

function fakeWindow() {
  return Object.assign(new EventEmitter(), {
    destroyed: false,
    isDestroyed() { return this.destroyed; },
    webContents: Object.assign(new EventEmitter(), { send: vi.fn() }),
  });
}

beforeEach(() => { vi.resetModules(); state.windows = []; });

it('uses the registered host even when a hidden App window is enumerated first', async () => {
  const main = fakeWindow();
  const background = fakeWindow();
  state.windows = [background, main];
  const bridge = await import('../../../ipc-bridge');
  const { getMainWindow } = await import('./window');
  bridge.setMainWindow(main as unknown as BrowserWindow);
  expect(getMainWindow()).toBe(main);
  state.windows.reverse();
  expect(getMainWindow()).toBe(main);
});

it('does not substitute another window before registration or after the real host closes', async () => {
  const background = fakeWindow();
  state.windows = [background];
  const bridge = await import('../../../ipc-bridge');
  const { getMainWindow } = await import('./window');
  expect(getMainWindow()).toBeNull();
  const old = fakeWindow();
  const replacement = fakeWindow();
  bridge.setMainWindow(old as unknown as BrowserWindow);
  bridge.setMainWindow(replacement as unknown as BrowserWindow);
  old.emit('closed');
  expect(getMainWindow()).toBe(replacement);
  replacement.destroyed = true;
  replacement.emit('closed');
  expect(getMainWindow()).toBeNull();
});
