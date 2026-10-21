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

/**
 * Whether a manifest network host pattern covers a hostname.
 * `*.example.com` covers example.com and any subdomain (Chrome's match
 * semantics); a bare host matches only itself. Comparison is case-insensitive;
 * a trailing dot (the DNS root, `example.com.`) resolves to the same host and
 * must not be a way around the list.
 */
export function networkHostMatches(pattern: string, hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  const rule = pattern.toLowerCase();
  if (rule.startsWith('*.')) {
    const base = rule.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return host === rule;
}

/** Whether any declared host pattern covers this hostname. */
export function networkHostAllowed(patterns: readonly string[], hostname: string): boolean {
  return patterns.some((pattern) => networkHostMatches(pattern, hostname));
}
