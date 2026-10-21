/**
 * The extension scheme and partition prefix, in a module with no imports.
 *
 * Deliberately dependency-free: gugu's host main.ts registers the scheme as
 * privileged before app ready, and it must be able to name it without pulling
 * the session-page module graph (and zod) into the host bundle. Refs #2374.
 */

/**
 * Own scheme rather than file:// — each extension gets a distinct, secure
 * origin, so storage is separated per extension and CSP can be pinned to it.
 * `gugu` is taken by the deeplink handler and `gugu-app` by the renderer.
 */
export const EXTENSION_SCHEME = 'gugu-ext';

/** Extension partitions are namespaced away from browser ones (persist:gugu-browser-*). */
export const EXTENSION_PARTITION_PREFIX = 'persist:gugu-extension-';
