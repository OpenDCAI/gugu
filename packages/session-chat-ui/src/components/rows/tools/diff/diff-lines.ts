/** Diff row selection and counts used by the transcript preview. */
import type { DiffRow } from '@gugu/session-core/lib';
export { computeDiffRows } from '@gugu/session-core/lib';
export type { DiffRow, DiffRowType } from '@gugu/session-core/lib';

/**
 * Count the total number of additions and deletions across a full diff.
 */
export function countChanges(rows: DiffRow[]): { adds: number; dels: number } {
  let adds = 0;
  let dels = 0;
  for (const row of rows) {
    if (row.type === 'add') adds++;
    else if (row.type === 'remove') dels++;
  }
  return { adds, dels };
}

/**
 * Select a preview window of `maxLines` rows anchored at the first changed line,
 * with `context` leading context lines before the first change.
 *
 * Returns an empty array when there are no changes.
 */
export function selectPreview(rows: DiffRow[], maxLines = 12, context = 1): DiffRow[] {
  const firstChange = rows.findIndex((r) => r.type !== 'context');
  if (firstChange === -1) return [];
  const start = Math.max(0, firstChange - context);
  return rows.slice(start, start + maxLines);
}
