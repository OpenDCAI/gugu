import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const root = style({ minWidth: 0, color: vars.fgMuted, fontFamily: vars.fontSans, fontSize: 14, lineHeight: '20px' });
export const trigger = style({ display: 'block', width: '100%', height: 32, boxSizing: 'border-box',
  border: 0, background: 'transparent', padding: '6px 0 6px 20px', textAlign: 'left',
  overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis', color: 'inherit',
  fontFamily: vars.fontSans, fontSize: 14, lineHeight: '20px', cursor: 'pointer',
  selectors: { '&:focus-visible': { outline: `1px solid ${vars.fgMuted}`, outlineOffset: -1 } } });
export const body = style({ padding: '0 0 6px 20px', vars: { [vars.fgBody]: vars.fgMuted } });
