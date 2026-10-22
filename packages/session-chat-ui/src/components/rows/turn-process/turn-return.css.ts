import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** 一行、不换行:高度是常量(measure 只返回 vars.height),❌ 让它随宽度变高。 */
export const turnReturnRow = style({ display: 'flex', alignItems: 'center', overflow: 'hidden', whiteSpace: 'nowrap', color: vars.fgMuted });

export const turnReturnLink = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  minWidth: 0,
  padding: 0,
  border: 0,
  background: 'none',
  color: 'inherit',
  font: 'inherit',
  cursor: 'pointer',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  selectors: { '&:hover': { color: vars.fg } },
});
