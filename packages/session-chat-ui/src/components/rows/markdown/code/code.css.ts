/**
 * code.css.ts — styles for Code.tsx.
 *
 * Code uses the nearest surface's color-scheme, including inverted message bubbles.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { artifactSurface } from '@session-chat/styles/effects.css';
import { vars } from '@session-chat/styles/theme.css';

/** Scroll + card container (inner div, no .pblock so overflow-x-auto wins). */
export const codeWrapper = style({
  ...artifactSurface,
  position: 'absolute',
  inset: 0,
  overflowX: 'auto',
  overflowY: 'hidden',
  paddingLeft: '8px',
  background: 'transparent',
  // Thin scrollbar
  scrollbarWidth: 'thin',
});

// Use the existing border token's 8% ink strength on the bubble's own text color.
// The page foreground may be the opposite of an inverted user bubble's ink.
// Keep the artifact width and radius, including its separate unbubbled treatment.
globalStyle(`[data-chat-root][data-agent-conversation="true"] [data-user-card] ${codeWrapper}`, {
  borderColor: 'color-mix(in oklab, currentColor 8%, transparent)',
});

/** Both palettes are emitted by Shiki; the painted surface chooses between them. */
globalStyle(`${codeWrapper} span`, {
  color: 'light-dark(var(--shiki-light), var(--shiki-dark))',
});

// Fences nested in lists/quotes use the shared HTML renderer instead of Code.tsx.
globalStyle(`[data-chat-root] .gg-md--transcript pre code span[style*="--shiki-light"]`, {
  color: 'light-dark(var(--shiki-light), var(--shiki-dark))',
});

/** Each code line div — font metrics come from --chat-type-code-* variables. */
export const codeLine = style({
  position: 'absolute',
  whiteSpace: 'pre',
  fontFamily: vars.typeCodeFontFamily,
  fontSize: vars.typeCodeFontSize,
  lineHeight: vars.typeCodeLineHeight,
  fontWeight: vars.typeCodeFontWeight,
  color: 'inherit',
});
