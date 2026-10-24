// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandShortcutBinder } from './command-shortcut-binder';
import { commandRegistry } from './registry';

const settings = vi.hoisted(() => ({ platform: 'windows' as 'windows' | 'linux', keyboard: {} as Record<string, string | null> }));
vi.mock('@renderer/features/settings/use-app-settings-key', () => ({ useAppSettingsKey: () => ({ value: settings.keyboard }) }));
vi.mock('@tanstack/react-hotkeys', async (original) => ({
  ...await original<typeof import('@tanstack/react-hotkeys')>(), detectPlatform: () => settings.platform,
}));
let root: Root;
let host: HTMLDivElement;
let input: HTMLTextAreaElement;
let dispose: () => void;
const find = vi.fn();
const widget = vi.fn((event: KeyboardEvent) => event.stopImmediatePropagation());

beforeEach(async () => {
  (globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  settings.keyboard = {};
  find.mockClear(); widget.mockClear();
  host = document.createElement('div'); document.body.append(host);
  input = document.createElement('textarea'); host.append(input);
  input.addEventListener('keydown', widget);
  const mount = document.createElement('div'); host.append(mount); root = createRoot(mount);
  await act(async () => {
    dispose = commandRegistry.register({ scopeId: 'session-sub', isActive: (target) => target === input,
      getCommands: () => [{ id: 'app.find', execute: find }] });
    root.render(<CommandShortcutBinder />);
  });
  await act(async () => input.focus());
});
afterEach(async () => {
  await act(async () => { root.unmount(); dispose(); });
  host.remove(); commandRegistry.setContext(document.body);
});
async function press(key: string) {
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true })); });
}

describe('find before terminal key consumption', () => {
  it.each(['windows', 'linux'] as const)('%s Ctrl+F reaches the command before a widget can swallow it', async (platform) => {
    settings.platform = platform;
    await act(async () => root.render(<CommandShortcutBinder key={platform} />));
    await press('f');
    expect(find).toHaveBeenCalledTimes(1);
    expect(widget).not.toHaveBeenCalled();
  });
  it('uses the command id override and releases the old chord after rebinding', async () => {
    settings.keyboard = { 'app.find': 'Mod+G' };
    await act(async () => root.render(<CommandShortcutBinder key="rebound" />));
    await press('f');
    expect(find).not.toHaveBeenCalled();
    expect(widget).toHaveBeenCalledTimes(1);
    await press('g');
    expect(find).toHaveBeenCalledTimes(1);
    expect(widget).toHaveBeenCalledTimes(1);
  });
});
