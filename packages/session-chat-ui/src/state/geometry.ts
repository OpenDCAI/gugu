/**
 * Snapshot types and equality helpers for the write-phase-owned geometry pass.
 *
 * Extracted from ChatRoot.tsx so unit tests can import these pure helpers
 * without pulling in any DOM-dependent modules.
 */

/**
 * Full geometry snapshot produced by derive() on each scheduler frame.
 * commit() diffs this against lastLayout and applies only the changed fields.
 */
export type LayoutSnapshot = {
  start: number;
  end: number;
  canvasHeight: number;
};

/**
 * Array equality for visible-row index arrays.
 * Returns true iff the arrays have the same length and identical elements.
 */
export function sameRange(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}
