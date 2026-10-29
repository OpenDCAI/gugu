/**
 * block-frame.css.ts — base positioning for all block-level content.
 *
 * BlockFrame renders a div with this class. Block-kind-specific visual styles
 * are applied via a second class prop.
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const pblock = style({
  position: 'absolute',
  left: 0,
  width: '100%',
  overflow: 'visible',
  // Ensure border-box sizing regardless of host preflight.
  boxSizing: 'border-box',
  // @@@load-bearing — paint containment is the frame's only clip.
  // `overflow: visible` above says this frame does not clip, and for `code`,
  // `mermaid` and `table` that is harmless: each fills the frame with an inset
  // surface that clips on its own. `prose` has no such surface — its lines are
  // absolutely positioned straight under this element — so what keeps a
  // transient measure-vs-render surplus from painting over the next block is
  // this containment. Measured (#3334 P3 fifth batch): with a 16px skew, 0 of
  // 10 prose descendants below the frame are hit-testable; drop the containment
  // on the same fixture and 10 of 10 become hit-testable
  // (`tests/markdown-rows.contract.test.tsx` carries that hit-test).
  //
  // ❌ Not `content-visibility: auto`, which used to supply it: the browser
  // decides a block is on screen only after the frame it scrolled in, so a
  // block entering the viewport painted empty for a frame or two — a user card
  // drawn without its text when scrolling back up (mac1 screencast, 2 frames
  // per pass). The virtualizer already keeps off-screen rows out of the DOM.
  contain: 'paint',
});

// ── Debug overlay ─────────────────────────────────────────────────────────────

export const debugOverlay = style({
  pointerEvents: 'none',
  position: 'absolute',
  inset: 0,
  outlineStyle: 'dashed',
  outlineWidth: '1px',
});

export const debugOk = style({
  outlineColor: vars.live,
});

export const debugMismatch = style({
  outlineColor: vars.diffDeleted,
});

export const debugLabel = style({
  position: 'absolute',
  top: 0,
  right: 0,
  // 反相小标签,同 unit-row 的 debugLabel。
  background: vars.fg,
  paddingLeft: '4px',
  paddingRight: '4px',
  fontSize: '10px',
  lineHeight: 'tight',
  color: vars.bg,
});

export const debugMismatchText = style({
  color: vars.diffDeleted,
});
