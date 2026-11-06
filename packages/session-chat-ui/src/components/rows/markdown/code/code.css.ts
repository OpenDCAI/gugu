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

// A conversation bubble already bounds its content. The page's artifact outline
// is uneven on inverted bubbles; keep the same borderless code in either bubble.
// Retain the reserved border width so measured code geometry does not change.
globalStyle(`[data-chat-root][data-agent-conversation="true"] [data-user-card] ${codeWrapper}`, {
  borderColor: 'transparent',
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
