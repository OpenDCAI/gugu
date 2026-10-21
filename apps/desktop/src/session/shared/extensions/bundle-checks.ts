import { bundleEntryRejection, MAX_BUNDLE_ENTRIES, MAX_BUNDLE_UNPACKED_BYTES } from './market';

/**
 * The package checks, in the order an install meets them: an archive before any byte of it is unpacked, the bytes as
 * they are unpacked, then what it holds. One set of rules for the desktop (main writes the files to disk) and the phone
 * (the outer gugu page keeps them for its App store, L9) — each only walks its own files; what passes is decided here.
 */

/** Before the first byte lands: the entry count, and every path — one bad path and the whole package is refused. */
export function archiveRefusal(entryNames: readonly string[]): string | null {
  if (entryNames.length > MAX_BUNDLE_ENTRIES) return `Bundle has too many entries: ${entryNames.length} > ${MAX_BUNDLE_ENTRIES}`;
  for (const name of entryNames) {
    const rejection = bundleEntryRejection(name);
    if (rejection) return `Refusing to unpack this bundle — ${rejection}`;
  }
  return null;
}

/**
 * While unpacking, counted as the bytes come — never after a whole file is in memory: a 25 MiB package can hold a file
 * that inflates to gigabytes. Past the limit, unpacking stops right there.
 */
export function unpackedTooMuch(bytesSoFar: number): string | null {
  return bytesSoFar > MAX_BUNDLE_UNPACKED_BYTES ? `Bundle unpacks to more than ${MAX_BUNDLE_UNPACKED_BYTES} bytes` : null;
}

/** One thing a package holds, by its path inside it ('/'-separated), in the order it was walked. */
export interface BundleEntry {
  path: string;
  kind: 'file' | 'directory' | 'link';
  /** A file's size; 0 for the others. */
  bytes: number;
}

/**
 * What it holds: every path passes `bundleEntryRejection`; no symbolic link (following one packs whatever it points at);
 * the files, counted and summed, within the unpack limits. Every problem is said, in walk order, none thrown.
 */
export function bundleProblems(entries: readonly BundleEntry[]): string[] {
  const problems: string[] = [];
  let files = 0;
  let bytes = 0;
  for (const entry of entries) {
    const rejection = bundleEntryRejection(entry.path);
    if (rejection) problems.push(rejection);
    if (entry.kind === 'link') problems.push(`symbolic link: ${entry.path}`);
    else if (entry.kind === 'file') {
      files += 1;
      bytes += entry.bytes;
    }
  }
  if (files > MAX_BUNDLE_ENTRIES) problems.push(`too many files: ${files} > ${MAX_BUNDLE_ENTRIES}`);
  if (bytes > MAX_BUNDLE_UNPACKED_BYTES) problems.push(`too large: ${bytes} bytes > ${MAX_BUNDLE_UNPACKED_BYTES}`);
  return problems;
}
