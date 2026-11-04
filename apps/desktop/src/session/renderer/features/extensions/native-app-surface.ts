import type { ExtensionSurfaceMetrics } from '@shared/extensions/bridge-protocol';
import { isBrowserPageOccluded } from '../browser/browser-page-occlusion';

/** Only the trusted renderer measures native embedding bounds; App HTML cannot enlarge this box. */
export function nativeAppSurfaceMetrics(element: HTMLElement, clipElement: HTMLElement, visible: boolean,
  width: number, height: number): ExtensionSurfaceMetrics {
  const box = element.getBoundingClientRect(), clip = clipElement.getBoundingClientRect();
  const doc = element.ownerDocument, win = doc.defaultView!;
  const x = Math.max(0, clip.x, box.x), y = Math.max(0, clip.y, box.y);
  const clipped = { x, y, width: Math.max(0, Math.min(win.innerWidth, clip.right, box.right) - x),
    height: Math.max(0, Math.min(win.innerHeight, clip.bottom, box.bottom) - y) };
  return { visible: visible && clipped.width > 0 && clipped.height > 0
    && !isBrowserPageOccluded(element, { left: x, top: y, width: clipped.width, height: clipped.height }),
    width, height, x: box.x, y: box.y, clip: clipped };
}

/** Menus/toasts/drag layers sit below native views. Hide that view while they occlude its App. */
export function observeNativeSurfaceOcclusion(report: () => void): () => void {
  const observer = new MutationObserver(report);
  observer.observe(document.body, { childList: true });
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-gugu-dragging'] });
  const timer = window.setInterval(report, 250);
  return () => { observer.disconnect(); window.clearInterval(timer); };
}
