import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const row = style({
  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
  height: 44, minWidth: 0, fontSize: vars.typeChromeTinyFontSize, lineHeight: '18px', color: vars.fgMuted,
});
export const toggle = style({
  position: 'absolute', inset: 0, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
  ':focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: -2 },
});
export const inline = style({
  position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%',
  pointerEvents: 'none', padding: '3px 5px',
});
export const label = style({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
export const name = style({
  all: 'unset', cursor: 'pointer', pointerEvents: 'auto', borderRadius: 2,
  ':hover': { textDecoration: 'underline' }, ':focus-visible': { outline: `2px solid ${vars.fgMuted}` },
});
export const icon = style({ flex: '0 0 auto', width: 14, height: 14 });
export const chevron = style({ flex: '0 0 auto', width: 12, height: 12, transition: 'transform 200ms ease',
  '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } } });
export const groupReply = style({ display: 'flex', alignItems: 'center', height: 32, fontSize: 12, lineHeight: '18px', color: vars.fgMuted, minWidth: 0 });
export const groupReplyButton = style({ all: 'unset', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  ':hover': { color: vars.fg }, ':focus-visible': { outline: `2px solid ${vars.fgMuted}` } });
