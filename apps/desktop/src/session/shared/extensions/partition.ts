import { isValidExtensionId } from './manifest';
import { EXTENSION_PARTITION_PREFIX, EXTENSION_SCHEME } from './scheme';

/**
 * Naming and matching rules for the isolated surface an extension renders in.
 * Shared because the renderer builds the <webview> src/partition while the main
 * process enforces both; one vocabulary, no second copy to drift. Refs #2374.
 */

export { EXTENSION_PARTITION_PREFIX, EXTENSION_SCHEME };

/** An App's session on this device: one per App, whoever is signed in — as a website's storage is the browser's (主人 10-01). */
export function extensionPartition(extensionId: string): string {
  return `${EXTENSION_PARTITION_PREFIX}${extensionId}`;
}

/** Extension id owning a partition, or null when it is not an extension partition. */
export function extensionIdFromPartition(partition: string): string | null {
  if (!partition.startsWith(EXTENSION_PARTITION_PREFIX)) return null;
  const extensionId = partition.slice(EXTENSION_PARTITION_PREFIX.length);
  return isValidExtensionId(extensionId) ? extensionId : null;
}

/** The extension's origin: one per extension, so nothing is shared between them. */
export function extensionOrigin(extensionId: string): string {
  return `${EXTENSION_SCHEME}://${extensionId}`;
}

/** URL of a bundle-relative file, e.g. the manifest entry. */
export function extensionResourceUrl(extensionId: string, relativePath: string): string {
  const normalized = relativePath.replace(/^\/+/, '');
  return `${extensionOrigin(extensionId)}/${normalized}`;
}

/**
 * Extension id addressed by a gugu-ext:// URL, or null if the URL is not one
 * (or names an id that could never be installed).
 */
export function extensionIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== `${EXTENSION_SCHEME}:`) return null;
  return isValidExtensionId(parsed.hostname) ? parsed.hostname : null;
}

export { networkHostMatches, networkHostAllowed } from './network-host';
