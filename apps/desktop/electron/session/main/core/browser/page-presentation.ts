import type { BrowserWindow, WebContentsView } from 'electron';
import type { TaskPagePresentation } from '@shared/extensions/task-page-protocol';

/** Only this native view and its actual host are measured; no window lookup or enumeration. */
export function nativePagePresentation(view: WebContentsView, host: BrowserWindow | null): TaskPagePresentation | null {
  if (!host || host.isDestroyed() || !host.isVisible() || host.isMinimized()
    || view.webContents.isDestroyed() || !view.getVisible()) return null;
  const box = view.getBounds(), content = host.getContentBounds();
  const zoomFactor = view.webContents.getZoomFactor();
  const windowId = /^window:([1-9][0-9]*):[0-9]+$/.exec(host.getMediaSourceId())?.[1];
  if (!windowId || !Number.isFinite(zoomFactor) || zoomFactor <= 0
    || ![box.x, box.y, box.width, box.height, content.x, content.y, content.width, content.height].every(Number.isFinite)) return null;
  const bounds = { x: content.x + box.x, y: content.y + box.y, width: box.width, height: box.height };
  const x = Math.max(content.x, bounds.x), y = Math.max(content.y, bounds.y);
  const width = Math.min(content.x + content.width, bounds.x + bounds.width) - x;
  const height = Math.min(content.y + content.height, bounds.y + bounds.height) - y;
  if (width <= 0 || height <= 0) return null;
  return { space: 'screen-dip', bounds, clip: { x, y, width, height }, zoomFactor, relativeTo: { windowId } };
}
