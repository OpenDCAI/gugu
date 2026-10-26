// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandShortcutBinder } from './command-shortcut-binder';
import { HotkeyRecorder } from '@tanstack/hotkeys';
import { commandRegistry } from './registry';

const settings = vi.hoisted(() => ({ platform: 'windows' as 'windows' | 'linux' | 'mac', keyboard: {} as Record<string, string | null> }));
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
  settings.platform = 'windows';
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
  await act(async () => { root.unmount(); dispose(); commandRegistry.setShortcutsPaused(false); });
  host.remove(); commandRegistry.setContext(document.body);
});
async function press(key: string) {
  await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key, ctrlKey: settings.platform !== 'mac', metaKey: settings.platform === 'mac', bubbles: true, cancelable: true })); });
}

describe('global commands before widget key consumption', () => {
  it('lets the shortcut recorder capture an assigned chord without executing it', async () => {
    const open = vi.fn();
    const recorded = vi.fn();
    const recorder = new HotkeyRecorder({ onRecord: recorded });
    let disposeEntry!: () => void;
    await act(async () => {
      disposeEntry = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id: 'app.commandPalette', execute: open }] });
      commandRegistry.setShortcutsPaused(true);
    });
    try {
      recorder.start();
      await press('p');
      expect(recorded).toHaveBeenCalledTimes(1);
      expect(open).not.toHaveBeenCalled();
      await act(async () => commandRegistry.setShortcutsPaused(false));
      await press('p');
      expect(open).toHaveBeenCalledTimes(1);
    } finally { recorder.destroy(); await act(async () => disposeEntry()); }
  });
  it.each([
    ['windows', 'app.quickSwitcher', 'o'], ['windows', 'app.commandPalette', 'p'],
    ['linux', 'app.quickSwitcher', 'o'], ['linux', 'app.commandPalette', 'p'],
    ['mac', 'app.quickSwitcher', 'o'], ['mac', 'app.commandPalette', 'p'],
  ] as const)('%s %s works inside a palette that stops bubbling', async (platform, id, key) => {
    settings.platform = platform;
    const open = vi.fn();
    host.setAttribute('cmdk-root', '');
    let disposeEntry!: () => void;
    await act(async () => {
      disposeEntry = commandRegistry.register({ scopeId: 'app', getCommands: () => [{ id, execute: open }] });
      root.render(<CommandShortcutBinder key={platform} />);
    });
    try {
      await press(key);
      expect(open).toHaveBeenCalledTimes(1);
      expect(widget).not.toHaveBeenCalled();
      expect(commandRegistry.contextElement).toBe(input);
    } finally { await act(async () => disposeEntry()); }
  });
  it.each(['windows', 'linux'] as const)('%s Ctrl+F reaches the command before a widget can swallow it', async (platform) => {
    settings.platform = platform;
    await act(async () => root.render(<CommandShortcutBinder key={platform} />));
    await press('f');
    expect(find).toHaveBeenCalledTimes(1);
    expect(widget).not.toHaveBeenCalled();
  });
  it.each(['windows', 'mac'] as const)('%s find keeps the clicked surface when its timeline cannot take focus', async (platform) => {
    settings.platform = platform;
    const timeline = document.createElement('p'); host.append(timeline);
    const findTimeline = vi.fn();
    let disposeTimeline!: () => void;
    await act(async () => {
      disposeTimeline = commandRegistry.register({ scopeId: 'session-sub', isActive: (target) => target === timeline,
        getCommands: () => [{ id: 'app.find', execute: findTimeline }] });
      root.render(<CommandShortcutBinder key={platform} />);
      input.blur();
      timeline.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
    });
    try {
      await act(async () => {
        document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', ctrlKey: platform === 'windows', metaKey: platform === 'mac', bubbles: true, cancelable: true }));
      });
      expect(findTimeline).toHaveBeenCalledTimes(1);
      expect(find).not.toHaveBeenCalled();
    } finally { await act(async () => disposeTimeline()); }
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
