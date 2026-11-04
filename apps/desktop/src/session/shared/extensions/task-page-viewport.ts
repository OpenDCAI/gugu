import type { ExtensionSurfaceMetrics } from './bridge-protocol';
export type NativePageRect = { x: number; y: number; width: number; height: number };

/** Intersect App-local CSS geometry with host-measured visible bounds, including App zoom and clipping. */
export function taskPageViewport(metrics: ExtensionSurfaceMetrics, rect: NativePageRect, scale: number): NativePageRect | null {
  if (!metrics.visible || !Number.isFinite(metrics.x) || !Number.isFinite(metrics.y) || !Number.isFinite(scale) || scale <= 0) return null;
  const x = metrics.x! + rect.x * scale, y = metrics.y! + rect.y * scale;
  const clip = metrics.clip ?? { x: metrics.x!, y: metrics.y!, width: metrics.width, height: metrics.height };
  const left = Math.max(metrics.x!, clip.x, x), top = Math.max(metrics.y!, clip.y, y);
  const right = Math.min(metrics.x! + metrics.width, clip.x + clip.width, x + rect.width * scale);
  const bottom = Math.min(metrics.y! + metrics.height, clip.y + clip.height, y + rect.height * scale);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}
