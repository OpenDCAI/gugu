import { BrowserWindow, webContents, type BrowserWindow as Window } from 'electron';

/** Native macOS page swipes enter the focused page's existing Mod+[ / Mod+] path.
 * Electron's swipe event requires the OS's two-or-three-finger page swipe setting;
 * wheel scrolling is never classified or intercepted as navigation.
 * https://www.electronjs.org/docs/latest/api/browser-window#event-swipe-macos
 */
export function attachTabHistorySwipe(window: Window): void {
  window.on('swipe', (_event, direction) => {
    if (direction !== 'left' && direction !== 'right') return;
    const target = webContents.getFocusedWebContents();
    if (!target || target.isDestroyed() || BrowserWindow.fromWebContents(target) !== window) return;
    const keyCode = direction === 'left' ? '[' : ']';
    target.sendInputEvent({ type: 'keyDown', keyCode, modifiers: ['meta'] });
    target.sendInputEvent({ type: 'keyUp', keyCode, modifiers: ['meta'] });
  });
}
