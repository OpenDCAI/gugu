import * as fs from 'node:fs';
import * as path from 'node:path';
import { nativeImage } from 'electron';
import { resolvesInside } from '@main/core/extensions/path-containment';
import { ICON_PIXELS, iconSizeRefusal, iconTypeRefusal } from '@shared/extensions/app-icon';

/**
 * Turns an extension's declared icon file into pixels the host produced itself.
 *
 * The hard part was never reading the field. Host chrome — the tab strip, the
 * 「+」menu, settings — renders in gugu's own privileged renderer, which has no
 * `gugu-ext://` handler (that scheme is registered per extension session) and
 * must not be pointed at extension-supplied bytes. So the bytes never travel:
 * main decodes the file with Electron's own decoder and **re-encodes** it, and
 * what the renderer receives is a PNG this process wrote. A crafted file that
 * happens to be a polyglot, or is not an image at all, does not survive a
 * decode/encode round trip — it fails to decode and the extension keeps the
 * generic mark.
 *
 * What may be an icon, how large, and at what size it is drawn are shared with the
 * phone, which re-encodes the same way in its gugu page (app-icon.ts). Refs #2374.
 */

export interface ExtensionIconFailure {
  reason: string;
}

/**
 * Returns a `data:image/png` URL of the host's own re-encoding, or a reason it
 * could not produce one. Never throws: a broken icon must not take down the
 * inventory read that lists every other extension.
 */
export function renderExtensionIcon(
  rootDir: string,
  iconRelativePath: string,
  pixels = ICON_PIXELS
): { dataUrl: string } | ExtensionIconFailure {
  const wrongType = iconTypeRefusal(iconRelativePath);
  if (wrongType) return { reason: wrongType };

  // Checked with the same primitive as every other extension-supplied path: a
  // manifest is input, and neither `..` nor a symlink in it may reach the rest
  // of the user's disk.
  const resolved = resolvesInside(path.resolve(rootDir), iconRelativePath);
  if (resolved === null) return { reason: 'icon path escapes the extension bundle' };

  let bytes: Buffer;
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return { reason: 'icon is not a file' };
    const tooLarge = iconSizeRefusal(stat.size);
    if (tooLarge) return { reason: tooLarge };
    bytes = fs.readFileSync(resolved);
  } catch {
    return { reason: 'icon file is missing or unreadable' };
  }

  const image = nativeImage.createFromBuffer(bytes);
  if (image.isEmpty()) return { reason: 'icon is not an image the host can decode' };

  const resized = image.resize({ width: pixels, height: pixels, quality: 'best' });
  const reencoded = resized.toPNG();
  if (reencoded.length === 0) return { reason: 'icon could not be re-encoded' };
  return { dataUrl: `data:image/png;base64,${reencoded.toString('base64')}` };
}
