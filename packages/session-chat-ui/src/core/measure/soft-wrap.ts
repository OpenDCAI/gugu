/**
 * soft-wrap — off-screen line breaking for rows that render pre-formatted text.
 *
 * The engine decides where a line breaks before the row is mounted (see
 * session-chat-ui spec: geometry is computed off-screen and projected into the
 * DOM), so the break points have to be computed from font metrics rather than
 * read back from a laid-out element. `measureSoftWrap` walks pretext at the
 * target width and reports both the resulting visual line count and the source
 * offsets the breaks landed on; `applySoftWraps` turns those offsets into real
 * newlines for the renderer.
 *
 * Two consumers today — the execute command body and the tool-call payload
 * panel — and they must agree, because a break point measured by one formula
 * and painted under another is exactly the class of 8px height drift documented
 * in execute.css.
 *
 * Rendering contract for anything consuming these offsets: paint under
 * `white-space: pre-wrap` with `overflow-wrap: normal` / `word-break: normal`.
 * `pre-wrap` is measured (a space sitting at a break hangs and costs the line no
 * width); painting the same text under `pre` turns that space back into a real
 * glyph and every line whose break followed a space comes out one advance wider
 * than it was measured to be.
 */

import { prepareWithSegments, walkLineRanges, type LayoutCursor } from '@chenglou/pretext';

/**
 * Scrollbar width pinned in CSS so the off-screen measurer can name it.
 *
 * A vertical scrollbar is the one thing that can steal width from a line after
 * it has been measured, and its width is a platform decision: 0 under macOS
 * overlay scrollbars, ~15px under the classic scrollbars used on Linux/Windows
 * and in headless Chromium. `scrollbar-gutter: stable` alone does not close
 * that — it reserves the *platform's* width, which the off-screen measurer still
 * cannot name. Pinning the scrollbar to a known width and reserving it in every
 * state makes the reservation the same 8px everywhere, which is what lets this
 * number appear in the measure math at all.
 */
export const MEASURED_SCROLLBAR_GUTTER_X = 8;

export type SoftWrapped = {
  /** Visual lines this source line occupies once wrapped at the target width. */
  visualLineCount: number;
  /** Source offsets the measured breaks landed on. */
  softWrapOffsets: number[];
};

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

function createSourceOffsetResolver(segments: string[]): (cursor: LayoutCursor) => number {
  const segmentStarts = [0];
  for (const segment of segments) {
    segmentStarts.push(segmentStarts[segmentStarts.length - 1] + segment.length);
  }
  const graphemeOffsets = new Map<number, number[]>();

  return (cursor) => {
    const segmentStart = segmentStarts[cursor.segmentIndex] ?? segmentStarts.at(-1) ?? 0;
    const segment = segments[cursor.segmentIndex];
    if (!segment || cursor.graphemeIndex === 0) return segmentStart;

    let offsets = graphemeOffsets.get(cursor.segmentIndex);
    if (!offsets) {
      offsets = [0];
      for (const grapheme of graphemeSegmenter.segment(segment)) {
        offsets.push(offsets[offsets.length - 1] + grapheme.segment.length);
      }
      graphemeOffsets.set(cursor.segmentIndex, offsets);
    }
    return segmentStart + (offsets[cursor.graphemeIndex] ?? segment.length);
  };
}

/**
 * Measure where `text` breaks when laid out at `width` px in `font`.
 *
 * `font` is a CSS font shorthand (the `font` half of a `FontConfig` variant).
 */
export function measureSoftWrap(text: string, width: number, font: string): SoftWrapped {
  const prepared = prepareWithSegments(text, font, { whiteSpace: 'pre-wrap' });
  const sourceOffsetAtCursor = createSourceOffsetResolver(prepared.segments);
  const wrapCandidates: number[] = [];
  const visualLineCount = walkLineRanges(prepared, Math.max(1, width), (visualLine) => {
    wrapCandidates.push(sourceOffsetAtCursor(visualLine.end));
  });
  // The last range ends at the end of the text; that is not a break.
  wrapCandidates.pop();
  const softWrapOffsets = wrapCandidates.filter(
    (offset, index, offsets) =>
      offset > 0 && offset < text.length && offset !== offsets[index - 1],
  );
  return { visualLineCount: Math.max(1, visualLineCount), softWrapOffsets };
}

/** Turn measured break offsets into real newlines for rendering. */
export function applySoftWraps(text: string, offsets: number[]): string {
  if (offsets.length === 0) return text;

  let wrapped = '';
  let start = 0;
  for (const offset of offsets) {
    wrapped += `${text.slice(start, offset)}\n`;
    start = offset;
  }
  return wrapped + text.slice(start);
}
