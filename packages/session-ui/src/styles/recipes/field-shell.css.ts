/**
 * fieldShellBase — shared visual shell for all field-shaped controls.
 *
 * Owns: border, background, hover border, invalid state, disabled.
 * No focus ring: per product spec the caret is the focus indicator.
 * Does NOT own: width, height, padding, font-size — those belong to each consumer.
 *
 * Composed by:
 *   - inputVariants (Input, Textarea, InputGroup)
 *   - TriggerButton appearance="input" (Select, ComboboxPopover form fields)
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const fieldShellBase = style({
  borderRadius: tokenVars.radiusMd,
  border: `1px solid ${vars.border}`,
  backgroundColor: vars.surfaceInput,
  color: vars.foreground,
  transition: 'color 150ms, box-shadow 150ms, border-color 150ms',
  outline: 'none',
  selectors: {
    '&::placeholder': { color: vars.foregroundPassive },
    '&:hover': { borderColor: vars.border1 },
    '&:disabled, &[data-disabled]': {
      pointerEvents: 'none',
      cursor: 'not-allowed',
      opacity: 0.5,
    },
    '&[aria-invalid="true"]': {
      borderColor: vars.borderDestructive,
      boxShadow: `0 0 0 3px color-mix(in srgb, ${vars.borderDestructive} 20%, transparent)`,
    },
  },
});
