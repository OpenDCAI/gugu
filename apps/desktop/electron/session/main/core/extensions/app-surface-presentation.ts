import type { AppSurfaceOptions } from '@shared/extensions/app-surface';

type NativeWindow = { isVisible(): boolean; showInactive(): void; hide(): void; moveAbove(source: string): void };
/** Native mechanics only; the App supplies its chosen window, placement and visibility. */
export function presentAppSurface(win: NativeWindow, intent: Pick<AppSurfaceOptions, 'visible' | 'relativeTo'>): { shown: boolean; reason?: string; error?: unknown } {
  try {
    if (!intent.visible) { win.hide(); return { shown: false }; }
    if (!win.isVisible()) win.showInactive();
    if (intent.relativeTo) win.moveAbove(`window:${intent.relativeTo.windowId}:0`);
    return { shown: win.isVisible() };
  } catch (error) {
    // A failed attachment must not leave the previous target's content floating over another App.
    win.hide(); return { shown: false, reason: 'display-unavailable', error };
  }
}
