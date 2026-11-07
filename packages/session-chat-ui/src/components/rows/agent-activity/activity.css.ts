import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';
import { ACTIVITY_METRICS as metrics } from './activity-metrics';

export const row = style({
  position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center',
  minHeight: metrics.height, minWidth: 0, fontSize: vars.typeChromeTinyFontSize, lineHeight: '18px', color: vars.fgMuted,
});
export const toggle = style({
  position: 'absolute', inset: 0, border: 0, background: 'transparent', color: 'inherit', cursor: 'pointer',
  ':focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: -2 },
});
export const inline = style({
  position: 'relative', display: 'inline-flex', alignItems: 'center', gap: metrics.gap, maxWidth: '100%',
  minWidth: 0, boxSizing: 'border-box', pointerEvents: 'none', padding: `${metrics.paddingY}px ${metrics.paddingX}px`,
});
export const label = style({ display: 'block', flex: '0 1 auto', minWidth: 0, overflow: 'hidden' });
export const line = style({ display: 'flex', height: metrics.lineHeight, whiteSpace: 'pre', alignItems: 'baseline' });
export const word = style({ flexShrink: 0, whiteSpace: 'pre' });
export const hanging = style({ flex: '0 0 0px', width: 0, overflow: 'hidden', whiteSpace: 'pre' });
export const name = style({
  all: 'unset', flexShrink: 0, cursor: 'pointer', pointerEvents: 'auto', borderRadius: 2,
  ':hover': { textDecoration: 'underline' }, ':focus-visible': { outline: `2px solid ${vars.fgMuted}` },
});
export const icon = style({ flex: '0 0 auto', width: metrics.icon, height: metrics.icon });
export const chevron = style({ flex: '0 0 auto', width: metrics.chevron, height: metrics.chevron, transition: 'transform 200ms ease',
  '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } } });
export const groupReply = style({ display: 'flex', alignItems: 'center', height: 32, fontSize: 12, lineHeight: '18px', color: vars.fgMuted, minWidth: 0 });
export const groupReplyButton = style({ all: 'unset', cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  ':hover': { color: vars.fg }, ':focus-visible': { outline: `2px solid ${vars.fgMuted}` } });
