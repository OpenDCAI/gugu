import { style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { composerRoot } from './chat-composer.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const status = style({
  alignSelf: 'center',
  maxWidth: '100%',
  overflowWrap: 'anywhere',
  fontSize: tokenVars.textTiny,
  lineHeight: tokenVars.textTinyLineHeight,
  color: vars.foregroundMuted,
  selectors: {
    [`${composerRoot}[data-mobile] &, [data-phone-shell] &`]: { gridColumn: '1 / -1', whiteSpace: 'normal' },
  },
});

/** Full failure text and retry stay available without enlarging every healthy tile. */
export const mobileError = style({
  display: 'none',
  selectors: {
    [`${composerRoot}[data-mobile] &, [data-phone-shell] &`]: {
      display: 'flex', flexWrap: 'wrap', gap: '0.25rem', gridColumn: '1 / -1',
      minWidth: 0, overflowWrap: 'anywhere', fontSize: tokenVars.textTiny,
      lineHeight: tokenVars.textTinyLineHeight, color: vars.foregroundError,
    },
  },
});

export const mobileQuality = style({
  display: 'none',
  selectors: {
    [`${composerRoot}[data-mobile] &, [data-phone-shell] &`]: {
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      position: 'absolute', left: '0.125rem', bottom: '0.125rem',
      width: '1.25rem', height: '1.25rem', padding: 0,
      backgroundColor: vars.surfaceBase, color: vars.foregroundMuted, borderRadius: tokenVars.radiusSm,
    },
    '&:disabled': { opacity: 0.5 },
    '&:focus-visible': { outline: `1px solid ${vars.border1}` },
  },
});

export const mobileName = style({
  display: 'none',
  selectors: {
    [`${composerRoot}[data-mobile] &, [data-phone-shell] &`]: {
      display: 'block', position: 'absolute', width: '1px', height: '1px',
      padding: 0, margin: '-1px', overflow: 'hidden', clipPath: 'inset(50%)', whiteSpace: 'nowrap',
    },
  },
});
