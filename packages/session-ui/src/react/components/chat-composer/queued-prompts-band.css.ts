import { style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';
import { durFast } from '@session-ui/styles/effects/animations.css';

// The queue is a compact tray above the composer, rather than another card.
export const band = style({
  minWidth: 0,
  padding: '0.25rem 0.5rem',
  marginBottom: '0.5rem',
  color: vars.foregroundMuted,
  fontSize: tokenVars.textSm,
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '0.125rem',
  maxHeight: '30dvh',
  overflowX: 'hidden',
  overflowY: 'auto',
  overscrollBehavior: 'contain',
});

export const row = style({
  display: 'grid',
  gridTemplateColumns: '1rem minmax(0, 1fr) auto',
  alignItems: 'center',
  gap: '0.5rem',
  minHeight: '2rem',
  borderRadius: tokenVars.radiusMd,
  padding: '0.125rem 0.25rem',
  selectors: {
    '&:hover, &:focus-within': { backgroundColor: vars.surfaceHover },
    '&[data-dragging]': { opacity: 0.56 },
    '&[data-editing]': { opacity: 0.6 },
    '&[data-drag-over]': { backgroundColor: vars.surfaceSelected },
  },
});

export const leadingSlot = style({ position: 'relative', width: '1rem', height: '1rem' });
export const queueIcon = style({
  width: '1rem', height: '1rem', color: vars.foregroundMuted,
});

export const dragHandle = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  border: 0,
  borderRadius: tokenVars.radiusSm,
  backgroundColor: vars.surfaceHover,
  padding: 0,
  color: vars.foregroundMuted,
  cursor: 'grab',
  opacity: 0,
  transition: `opacity ${durFast}`,
  selectors: {
    [`${row}:hover &, ${row}:focus-within &`]: { opacity: 1 },
    [`${row}[data-dragging] &`]: { opacity: 1, cursor: 'grabbing' },
    '&:focus-visible': { opacity: 1, outline: `1px solid ${vars.border1}` },
  },
});
export const dragHandleIcon = style({ width: '0.875rem', height: '0.875rem' });

export const promptText = style({
  minWidth: 0,
  border: 0,
  backgroundColor: 'transparent',
  padding: 0,
  color: 'inherit',
  font: 'inherit',
  textAlign: 'left',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  lineHeight: '1.25rem',
  cursor: 'text',
  selectors: {
    '&:focus-visible': { outline: `1px solid ${vars.border1}`, outlineOffset: 2 },
    '&[data-locked="true"]': { cursor: 'default' },
  },
});
export const emptyText = style({ color: vars.foregroundMuted });

// Actions own a real grid column, so long text can never cover their targets.
export const actions = style({ display: 'flex', alignItems: 'center', gap: '0.125rem' });
export const actionIcon = style({ width: '0.875rem', height: '0.875rem', flexShrink: 0 });
export const sendNow = style({ whiteSpace: 'nowrap', gap: '0.25rem' });
