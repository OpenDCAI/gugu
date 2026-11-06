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
    [`${composerRoot}[data-mobile] &, [data-phone-shell] &`]: { flexShrink: 0, whiteSpace: 'nowrap' },
  },
});
