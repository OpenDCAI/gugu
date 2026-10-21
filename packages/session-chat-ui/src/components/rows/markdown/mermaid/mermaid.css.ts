/**
 * mermaid.css.ts — styles for the Mermaid diagram preview block.
 *
 * Fixed 21:9 aspect-ratio clickable container: card border, overflow hidden,
 * transparent background under the themed SVG, and a hover affordance for the
 * click-to-view affordance.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { artifactSurface } from '@session-chat/styles/effects.css';
import { vars } from '@session-chat/styles/theme.css';

/** Outer container — absolute inset-0 within the BlockFrame. */
export const mermaidWrapper = style({
  ...artifactSurface,
  position: 'absolute',
  inset: 0,
  overflow: 'hidden',
  background: 'transparent',
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  ':hover': {
    borderColor: vars.fgMuted,
  },
});

/**
 * The box the SVG markup is injected into. It must have the wrapper's size: a
 * percentage height on the SVG resolves against it, and an auto-height box
 * would let a tall diagram keep its intrinsic height and spill out of the frame.
 */
export const mermaidCanvas = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

/** SVG inside the wrapper fills the container preserving diagram proportions. */
globalStyle(`${mermaidWrapper} svg`, {
  width: '100%',
  height: '100%',
  display: 'block',
});

/** Placeholder shown before the idle SVG render completes. */
export const mermaidPlaceholder = style({
  fontFamily: vars.fontSans,
  // @@@type-chrome (Refs #6104) — 这句是**要读的内容**(等图画出来 / 图画错了),取 chrome 正文那一档
  // (#7333:紧凑界面 14/20),不是标记档。
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  color: vars.fgPassive,
  userSelect: 'none',
  pointerEvents: 'none',
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

/** Fallback label when the diagram source is invalid. */
export const mermaidError = style({
  fontFamily: vars.fontSans,
  fontSize: vars.typeChromeFontSize,
  lineHeight: '20px',
  color: vars.fgError,
  userSelect: 'none',
  pointerEvents: 'none',
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});
