import { EventEmitter } from 'node:events';
import { beforeEach, expect, it, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const state = vi.hoisted(() => ({ focused: null as unknown, owner: null as unknown }));
vi.mock('electron', () => ({
  webContents: { getFocusedWebContents: () => state.focused },
  BrowserWindow: { fromWebContents: () => state.owner },
}));
import { attachTabHistorySwipe } from '../../../../apps/desktop/electron/tab-history-swipe';

let window: EventEmitter;
let target: { isDestroyed: () => boolean; sendInputEvent: ReturnType<typeof vi.fn> };
beforeEach(() => {
  window = new EventEmitter();
  target = { isDestroyed: () => false, sendInputEvent: vi.fn() };
  state.focused = target;
  state.owner = window;
  attachTabHistorySwipe(window as BrowserWindow);
});

it('sends native left/right page swipes through the focused page’s existing history shortcuts', () => {
  window.emit('swipe', {}, 'left');
  window.emit('swipe', {}, 'right');
  expect(target.sendInputEvent.mock.calls.map(([event]) => event)).toEqual([
    { type: 'keyDown', keyCode: '[', modifiers: ['meta'] },
    { type: 'keyUp', keyCode: '[', modifiers: ['meta'] },
    { type: 'keyDown', keyCode: ']', modifiers: ['meta'] },
    { type: 'keyUp', keyCode: ']', modifiers: ['meta'] },
  ]);
});

it('does not send a swipe into another window or an absent/destroyed page, and ignores vertical gestures', () => {
  state.owner = new EventEmitter();
  window.emit('swipe', {}, 'left');
  state.owner = window;
  state.focused = null;
  window.emit('swipe', {}, 'left');
  state.focused = { ...target, isDestroyed: () => true };
  window.emit('swipe', {}, 'left');
  state.focused = target;
  window.emit('swipe', {}, 'up');
  expect(target.sendInputEvent).not.toHaveBeenCalled();
});
