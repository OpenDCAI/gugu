/**
 * tool-images — geometry for the strip of pictures a tool handed back (148 10-14).
 *
 * A tool's pictures (an App's app_check, a browser screenshot …) sit under the row's header as a strip of thumbnails,
 * visible without opening the row: the pictures are what the call was for. Clicking one opens the app's image viewer
 * on all of them (ChatCommands.onViewImages).
 *
 * The strip is a Lane A input like the payload panel: its height is a constant, never the pictures' own size. Each
 * thumbnail is a fixed box the picture is contained in, so a picture of any size or shape — or one still decoding —
 * paints the same height the row measured, and one tool returning many large pictures adds one strip, not a wall:
 * at most `TOOL_THUMB_MAX` boxes, as many as the width holds, the last one saying how many more there are.
 */

/** Thumbnail box (px): ≤160 tall, ≤240 wide, as 148 capped it. */
export const TOOL_THUMB_W = 160;
export const TOOL_THUMB_H = 120;
export const TOOL_THUMB_GAP = 6;
/** Room above (from the header) and below the boxes. */
export const TOOL_THUMB_PAD_TOP = 2;
export const TOOL_THUMB_PAD_BOTTOM = 6;
/** The strip shows at most this many boxes; the rest are a click away in the viewer. */
export const TOOL_THUMB_MAX = 4;
/** The strip's height: a constant, whatever the pictures are. */
export const TOOL_THUMB_STRIP_H = TOOL_THUMB_PAD_TOP + TOOL_THUMB_H + TOOL_THUMB_PAD_BOTTOM;

export type ToolThumbStrip = {
  /** How many boxes the strip paints. */
  shown: number;
  /** Pictures not painted; the last box says `+more` over its picture. */
  more: number;
  stripH: number;
};

/** The strip for `count` pictures at `width`, or null when there are none. */
export function toolThumbStrip(count: number, width: number): ToolThumbStrip | null {
  if (count <= 0) return null;
  const fit = Math.max(1, Math.floor((width + TOOL_THUMB_GAP) / (TOOL_THUMB_W + TOOL_THUMB_GAP)));
  const shown = Math.min(count, TOOL_THUMB_MAX, fit);
  return { shown, more: count - shown, stripH: TOOL_THUMB_STRIP_H };
}
