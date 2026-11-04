import { expect, it, vi } from 'vitest';
import { presentAppSurface } from './app-surface-presentation';
function window() {
  let visible = false;
  return { isVisible: () => visible, showInactive: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }), moveAbove: vi.fn() };
}
it('permits a hidden pre-created surface to be shown later relative to the App-selected native window', () => {
  const win = window();
  expect(presentAppSurface(win, { visible: false })).toEqual({ shown: false });
  expect(win.showInactive).not.toHaveBeenCalled();
  expect(presentAppSurface(win, { visible: true, relativeTo: { windowId: '1234' } })).toEqual({ shown: true });
  expect(win.moveAbove).toHaveBeenCalledWith('window:1234:0');
  presentAppSurface(win, { visible: true, relativeTo: { windowId: '1234' } });
  expect(win.showInactive).toHaveBeenCalledTimes(1);
});
it('hides stale content when attachment fails and permits a later display update to recover', () => {
  const win = window();
  presentAppSurface(win, { visible: true, relativeTo: { windowId: '1234' } });
  win.moveAbove.mockImplementationOnce(() => { throw new Error('native window gone'); });
  expect(presentAppSurface(win, { visible: true, relativeTo: { windowId: '5678' } })).toEqual({ shown: false, reason: 'display-unavailable', error: expect.objectContaining({ message: 'native window gone' }) });
  expect(win.isVisible()).toBe(false);
  expect(presentAppSurface(win, { visible: true, relativeTo: { windowId: '9999' } })).toEqual({ shown: true });
});
