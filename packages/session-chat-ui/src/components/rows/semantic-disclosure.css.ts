import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const row = style({
  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center', minWidth: 0,
  color: vars.fgMuted, fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize, lineHeight: '18px',
});
export const toggle = style({
  position: 'absolute', inset: 0, width: '100%', border: 0, padding: 0, background: 'transparent', cursor: 'pointer',
  ':focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: -2 },
});
export const inline = style({
  display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', minWidth: 0,
  padding: '3px 5px', pointerEvents: 'none',
});
export const label = style({ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' });
export const chevron = style({
  flex: '0 0 auto', width: 12, height: 12, transition: 'transform 200ms ease',
  '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } },
});
