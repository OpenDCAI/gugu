import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const step = style({ display: 'flex', alignItems: 'center', gap: 8, height: 32, minWidth: 0, width: '100%',
  border: 0, background: 'transparent', padding: 0, textAlign: 'left', cursor: 'pointer',
  fontFamily: vars.fontSans, fontSize: 14, lineHeight: '20px', color: vars.fgPassive, selectors: { '&:disabled': { cursor: 'default' } } });
export const row = style({ minWidth: 0, color: vars.fgPassive });
export const noticeSummary = style({ minWidth: 0, overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' });
export const slot = style({ width: 12, flexShrink: 0, display: 'flex', alignItems: 'center' });
export const name = style({ flexShrink: 0, whiteSpace: 'nowrap' });
export const detail = style({ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
  fontFamily: vars.fontSans, fontSize: 12, lineHeight: '18px', padding: '1px 5px', borderRadius: 6,
  background: 'color-mix(in srgb, currentColor 6%, transparent)' });
export const status = style({ flexShrink: 0, marginLeft: 'auto', fontSize: 12 });
