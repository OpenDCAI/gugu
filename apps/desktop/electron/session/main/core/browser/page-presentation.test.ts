import { expect, it } from 'vitest';
import type { BrowserWindow, WebContentsView } from 'electron';
import { nativePagePresentation } from './page-presentation';

function native() {
  const state = { shown: true, destroyed: false, minimized: false, viewShown: true, zoom: 1.5,
    source: 'window:712:0', box: { x: -20, y: 30, width: 300, height: 200 }, content: { x: -1200, y: 80, width: 800, height: 600 } };
  const host = { isDestroyed: () => state.destroyed, isVisible: () => state.shown, isMinimized: () => state.minimized,
    getContentBounds: () => state.content, getMediaSourceId: () => state.source } as BrowserWindow;
  const view = { getVisible: () => state.viewShown, getBounds: () => state.box,
    webContents: { isDestroyed: () => state.destroyed, getZoomFactor: () => state.zoom } } as WebContentsView;
  return { state, host, view, read: () => nativePagePresentation(view, host) };
}

it('uses native view bounds, actual page zoom and content origin in screen DIP, including negative displays and clipping', () => {
  const { read } = native();
  expect(read()).toEqual({ space: 'screen-dip', bounds: { x: -1220, y: 110, width: 300, height: 200 },
    clip: { x: -1200, y: 110, width: 280, height: 200 }, zoomFactor: 1.5, relativeTo: { windowId: '712' } });
});
it('returns no geometry for hidden, minimized, destroyed, detached or completely clipped views', () => {
  for (const patch of [{ shown: false }, { minimized: true }, { destroyed: true }, { viewShown: false },
    { box: { x: 900, y: 0, width: 100, height: 100 } }]) {
    const { state, read } = native(); Object.assign(state, patch); expect(read()).toBeNull();
  }
  expect(nativePagePresentation(native().view, null)).toBeNull();
});
it('refuses guessed native IDs, invalid bounds and invalid zoom rather than inventing display state', () => {
  for (const patch of [{ source: 'screen:712:0' }, { source: 'window:0:0' }, { zoom: NaN }, { zoom: 0 },
    { box: { x: Infinity, y: 0, width: 100, height: 100 } }]) {
    const { state, read } = native(); Object.assign(state, patch); expect(read()).toBeNull();
  }
});
