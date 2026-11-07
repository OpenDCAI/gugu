/**
 * Bound optional cache work by already-consumed native bytes. This interim
 * 32 MiB cap restores medium-session caching pending bounded history windows.
 */
export const TIMELINE_ARCHIVE_MAX_SOURCE_BYTES = 32 * 1024 * 1024;

export function fitsTimelineArchiveSourceBudget(sourceBytes: number | undefined): boolean {
  return typeof sourceBytes === 'number' && Number.isSafeInteger(sourceBytes) && sourceBytes >= 0
    && sourceBytes <= TIMELINE_ARCHIVE_MAX_SOURCE_BYTES;
}
