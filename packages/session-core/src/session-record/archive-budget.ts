/**
 * Bound optional cache work by already-consumed native bytes. 8 MiB exceeded
 * the MBP's 30 ms parse target; 7.5 MiB keeps 7 MiB sessions cacheable.
 */
export const TIMELINE_ARCHIVE_MAX_SOURCE_BYTES = 7.5 * 1024 * 1024;

export function fitsTimelineArchiveSourceBudget(sourceBytes: number | undefined): boolean {
  return typeof sourceBytes === 'number' && Number.isSafeInteger(sourceBytes) && sourceBytes >= 0
    && sourceBytes <= TIMELINE_ARCHIVE_MAX_SOURCE_BYTES;
}
