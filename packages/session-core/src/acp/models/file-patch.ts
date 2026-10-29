import type { SessionFileChange, SessionPatch } from '../session-protocol';

/** The structured destination is the file identity, independent of patch headers. */
export function changedFilePath(change: SessionFileChange): string | undefined {
  return typeof change.path === 'string' && change.path.length ? change.path : undefined;
}

export function changedFilePaths(patches: readonly SessionPatch[]): string[] {
  return [...new Set(patches.flatMap(patch => patch.changes.flatMap(change => {
    const path = changedFilePath(change);
    return path ? [path] : [];
  })))];
}
