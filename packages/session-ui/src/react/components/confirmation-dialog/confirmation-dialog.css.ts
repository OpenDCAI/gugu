import { style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const description = style({
  fontSize: tokenVars.textSm,
  color: vars.foregroundMuted,
});
