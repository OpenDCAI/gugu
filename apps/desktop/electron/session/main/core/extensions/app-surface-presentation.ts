import type { AppSurfaceOptions } from '@shared/extensions/app-surface';

type NativeWindow = { isVisible(): boolean; showInactive(): void; hide(): void; moveAbove(source: string): void;
  setIgnoreMouseEvents(ignore: boolean): void; setFocusable(focusable: boolean): void };
/** Native mechanics only; the App supplies its chosen window, placement and visibility. */
export function presentAppSurface(win: NativeWindow, intent: Pick<AppSurfaceOptions, 'visible' | 'relativeTo'> & { decorative?: boolean }): { shown: boolean; reason?: string; error?: unknown } {
  try {
    if (intent.decorative) {
      // Must succeed before any show, including a later update. Never forward native mouse events to this document.
      win.setIgnoreMouseEvents(true);
      win.setFocusable(false);
    }
    if (!intent.visible) { win.hide(); return { shown: false }; }
    if (!win.isVisible()) win.showInactive();
    if (intent.relativeTo) win.moveAbove(`window:${intent.relativeTo.windowId}:0`);
    return { shown: win.isVisible() };
  } catch (error) {
    // A failed attachment must not leave the previous target's content floating over another App.
    win.hide(); return { shown: false, reason: 'display-unavailable', error };
  }
}
