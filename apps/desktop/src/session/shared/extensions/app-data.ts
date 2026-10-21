/**
 * An App's own data folder (`gugu.readData` / `writeData` / `listData`): kept by main on the desktop
 * (extension-data.ts) and by the phone's App store (phoneApps.ts, L9) — the same limit on both.
 */

/** Enough for a notebook or a cache index; not a place for datasets. */
export const MAX_APP_DATA_FILE_BYTES = 8 * 1024 * 1024;

/** Why content of this many bytes cannot be written there, or null. */
export function appDataTooLarge(bytes: number): string | null {
  return bytes > MAX_APP_DATA_FILE_BYTES ? `file is larger than ${MAX_APP_DATA_FILE_BYTES} bytes` : null;
}
