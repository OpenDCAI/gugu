/**
 * Path utilities — pure string helpers for file paths.
 */

/** Return the last path segment, e.g. "src/foo/bar.ts" → "bar.ts". */
export function basename(path: string): string {
  return path.split('/').pop() ?? path;
}

/**
 * How many directory levels a row keeps in front of the file name.
 *
 * Two, read off the shape of the paths agents actually touch: one level is not
 * enough to separate `rows/tools/file-op/index.ts` from `rows/tools/diff/index.ts`
 * once the leaf is `index.ts`, and beyond two the kept text stops being the part
 * that differs and starts being the part every sibling row already repeats.
 */
const KEPT_DIR_SEGMENTS = 2;

/** The head-elision marker. A whole directory level was dropped, never half of one. */
export const PATH_ELLIPSIS = '…/';

export type DisplayPath = {
  /** `…/` when directory levels were dropped from the head, otherwise empty. */
  elided: string;
  /** The kept directory levels, trailing slash included. Empty for a bare file name. */
  dir: string;
  /** The file name. Never dropped: it is the token the reader is looking for. */
  name: string;
};

/**
 * Split a path into the three pieces a file row draws.
 *
 * Elision happens at the **head** because that is where rows repeat each other:
 * thirty rows under one project share their first segments and differ only in
 * their last ones, so keeping the tail is what makes them tell apart. Splitting
 * on `/` rather than on a character budget is what keeps a dropped level whole —
 * a character-wise cut can leave `ask-chat-ui/src/` standing, which reads like a
 * directory that does not exist.
 *
 * The width is not an input. A row is one line whatever its path, so the text it
 * carries must not depend on a measurement — otherwise the same row would have
 * to be re-derived every time the transcript is resized, on the layout lane.
 * What does not fit is handled downstream by the row's own ellipsis rule.
 */
export function displayPath(path: string): DisplayPath {
  const segments = path.split('/');
  const name = segments.pop() ?? path;
  // A leading "/" produces an empty first segment; it carries no level of its own.
  const dirs = segments.filter((segment) => segment.length > 0);
  const kept = dirs.slice(Math.max(0, dirs.length - KEPT_DIR_SEGMENTS));
  return {
    elided: kept.length < dirs.length ? PATH_ELLIPSIS : '',
    dir: kept.length > 0 ? `${kept.join('/')}/` : '',
    name,
  };
}
