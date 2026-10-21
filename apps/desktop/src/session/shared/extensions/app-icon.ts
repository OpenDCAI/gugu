/**
 * An App tab's icon, as gugu draws it: never the App's own bytes, but the host's re-encoding of them into a small PNG —
 * by main on the desktop (extension-icon.ts), by the outer gugu page on the phone (phoneApps.ts, L9). The same types,
 * the same limit, the same size on both.
 */

/** Drawn at 16px, re-encoded at 2× so it stays sharp on a retina display. */
export const ICON_PIXELS = 32;
/** An App's own icon: 22px on the far-left rail (its dock), 32 on the App page's row, 44 in its detail dialog — 88 is 44 at 2×. */
export const APP_ICON_PIXELS = 88;

/**
 * What the host will decode. ❌ SVG is refused rather than sanitized: it is a document format with script and external
 * references in it, and 「大概清理干净了」is not a security argument. A raster icon costs an author one export.
 */
const ICON_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp'] as const;

/**
 * Refused above this size before decoding. A tab icon needs kilobytes; anything larger is either a mistake or an attempt
 * to make the host decode something expensive on every inventory read.
 */
const MAX_ICON_BYTES = 512 * 1024;

/** Why this path cannot be an icon (its type), or null. Checked before anything is read. */
export function iconTypeRefusal(relativePath: string): string | null {
  const name = relativePath.toLowerCase();
  const dot = name.lastIndexOf('.');
  const extension = dot > name.lastIndexOf('/') ? name.slice(dot) : '';
  return (ICON_EXTENSIONS as readonly string[]).includes(extension) ? null : `icon must be one of ${ICON_EXTENSIONS.join(', ')}`;
}

/** Why a file of this size cannot be an icon, or null. */
export function iconSizeRefusal(bytes: number): string | null {
  return bytes > MAX_ICON_BYTES ? 'icon is larger than 512 KB' : null;
}

/** Where a file icon (`fileIcons`) is kept next to its tab's icon: the tab kind, a space (no tab name has one), the claim. */
export function fileIconKey(tabKind: string, claim: string): string {
  return `${tabKind} ${claim}`;
}
