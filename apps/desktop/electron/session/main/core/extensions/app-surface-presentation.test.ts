import { expect, it, vi } from 'vitest';
import { presentAppSurface } from './app-surface-presentation';
function window() {
  let visible = false;
  return { isVisible: () => visible, showInactive: vi.fn(() => { visible = true; }),
    hide: vi.fn(() => { visible = false; }), moveAbove: vi.fn(), setIgnoreMouseEvents: vi.fn(), setFocusable: vi.fn() };
}
it('configures native passthrough without forwarding and focus before showing a decorative window', () => {
  const win = window();
  expect(presentAppSurface(win, { visible: true, decorative: true })).toEqual({ shown: true });
  expect(win.setIgnoreMouseEvents).toHaveBeenCalledExactlyOnceWith(true);
  expect(win.setFocusable).toHaveBeenCalledExactlyOnceWith(false);
  expect(win.setIgnoreMouseEvents.mock.invocationCallOrder[0]).toBeLessThan(win.showInactive.mock.invocationCallOrder[0]!);
});
it('does not show or retain a blocking fallback if native passthrough cannot be set', () => {
  const win = window(); win.setIgnoreMouseEvents.mockImplementation(() => { throw new Error('not supported'); });
  expect(presentAppSurface(win, { visible: true, decorative: true })).toMatchObject({ shown: false, reason: 'display-unavailable' });
  expect(win.showInactive).not.toHaveBeenCalled(); expect(win.isVisible()).toBe(false);
});
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
