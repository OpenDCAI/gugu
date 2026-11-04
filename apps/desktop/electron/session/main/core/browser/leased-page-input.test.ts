import { expect, it, vi } from 'vitest';
import { LeasedPageInput } from './leased-page-input';

it('releases only this lease’s dispatched controls without replaying text or original intent', async () => {
  const input = new LeasedPageInput();
  const unknown = Promise.withResolvers<unknown>();
  input.sent('Input.dispatchKeyEvent', { type: 'keyDown', key: 'A', code: 'KeyA', text: 'a', commands: ['paste'] }, undefined, unknown.promise);
  input.sent('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', x: 10, y: 20 }, 'child', unknown.promise);
  input.sent('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 30, y: 40 }, 'child', unknown.promise);
  input.sent('Input.insertText', { text: 'once' }, undefined, unknown.promise);
  const send = vi.fn<(method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>>(async () => ({}));
  await input.release(send);
  expect(send.mock.calls).toEqual([
    ['Input.dispatchKeyEvent', { type: 'keyUp', modifiers: 0, key: 'A', code: 'KeyA' }, undefined],
    ['Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', buttons: 0, x: 30, y: 40, modifiers: 0, clickCount: 1 }, 'child'],
  ]);
  await input.release(send);
  expect(send).toHaveBeenCalledTimes(2);
  unknown.resolve({});
});

it('an old release result cannot forget a newer held key, while a completed release needs no extra event', async () => {
  const input = new LeasedPageInput();
  const oldUp = Promise.withResolvers<unknown>();
  const key = { key: 'Shift', code: 'ShiftLeft' };
  input.sent('Input.dispatchKeyEvent', { ...key, type: 'keyDown' }, undefined, Promise.resolve());
  input.sent('Input.dispatchKeyEvent', { ...key, type: 'keyUp' }, undefined, oldUp.promise);
  input.sent('Input.dispatchKeyEvent', { ...key, type: 'keyDown' }, undefined, Promise.resolve());
  oldUp.resolve({}); await oldUp.promise;
  input.sent('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'right', x: 1, y: 2 }, undefined, Promise.resolve());
  input.sent('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'right' }, undefined, Promise.resolve());
  await Promise.resolve();
  const send = vi.fn<(method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>>(async () => ({}));
  await input.release(send);
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('Input.dispatchKeyEvent', { ...key, type: 'keyUp', modifiers: 0 }, undefined);
});

it('tries every held release even if one fails, and stops admitting new held controls', async () => {
  const input = new LeasedPageInput();
  input.sent('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 2 }] }, undefined, Promise.resolve());
  input.sent('Input.dispatchDragEvent', { type: 'dragEnter', x: 1, y: 2, data: { items: [], dragOperationsMask: 1 } }, undefined, Promise.resolve());
  const send = vi.fn<(method: string, params: Record<string, unknown>, sessionId?: string) => Promise<unknown>>(async () => { throw new Error('disconnected'); });
  await expect(input.release(send)).rejects.toThrow('Leased page input release failed');
  expect(send).toHaveBeenCalledTimes(2);
  expect(send.mock.calls.map(([method, params]) => [method, params.type])).toEqual([
    ['Input.dispatchTouchEvent', 'touchCancel'], ['Input.dispatchDragEvent', 'dragCancel'],
  ]);
  input.sent('Input.dispatchKeyEvent', { type: 'keyDown', key: 'B' }, undefined, Promise.resolve());
  await input.release(send);
  expect(send).toHaveBeenCalledTimes(2);
});
