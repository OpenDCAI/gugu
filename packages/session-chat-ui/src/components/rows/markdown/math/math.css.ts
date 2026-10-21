/**
 * math.css.ts — styles for typeset LaTeX, inline and display.
 *
 * These classes are applied to BOTH the rendered formula and the offscreen node
 * the measurement tier typesets into. That is the whole point of exporting
 * them: a formula measured under one set of rules and painted under another is
 * a reserved height that does not match the painted height, which the
 * virtualizer turns into overlapping rows.
 *
 * Consequence: nothing here that affects geometry may read a theme CSS variable.
 * The measure host lives on `document.body`, outside the chat root where those
 * variables are defined, so a `var()` width or font-size would resolve to its
 * fallback there and to the real value in the transcript. Colour is free to use
 * them — it does not move anything. Font size is not a class at all; it is
 * passed inline from the measured layout.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** Display formula content — absolutely fills its BlockFrame. */
export const mathBlock = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  // A formula wider than the transcript scrolls rather than being clipped or
  // reflowed; KaTeX does not line-break. Mirrors the code block's containment.
  overflowX: 'auto',
  overflowY: 'hidden',
  lineHeight: 'normal',
  color: vars.fg,
});

/**
 * The measured box: the exact element the offscreen measurer sizes, and the
 * exact element the renderer paints. `katex-display` carries a `1em 0` margin
 * of its own that would show up as unreserved height, so it is zeroed here —
 * vertical rhythm around the block belongs to the block def's `margin()`.
 */
export const mathContent = style({
  display: 'block',
  flex: '0 0 auto',
  margin: 0,
});

globalStyle(`${mathContent} .katex-display`, {
  margin: 0,
});

/** Failed formulas keep the source visible instead of vanishing. */
export const mathError = style({
  fontFamily: vars.fontMono,
  color: vars.fgError,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
});
