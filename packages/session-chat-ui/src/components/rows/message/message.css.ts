import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { messageGroup } from '@session-chat/components/primitives/copy-button.css';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type AssistantStyleVars = { height: number };

export const assistantVars = createVariableThemeContract<AssistantStyleVars>({ height: null });

// overflow: hidden ensures that any transient measure-vs-render height desync
// (e.g. a mid-tween frame or a stale virtualizer size) degrades to clipped
// content rather than painting over the following row — the same guard every
// other engine-height row root carries.
export const assistantRoot = style({ height: assistantVars.height, overflow: 'hidden' });

export const messageText = recipe({
  variants: {
    role: {
      assistant: { color: vars.fgBody },
      thought: { color: vars.fgMuted, fontStyle: 'italic' },
    },
  },
});

export const assistantOuter = style([messageGroup, { position: 'relative' }]);

export const srOnly = style({
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  borderWidth: 0,
});

export const footerRow = style({
  display: 'flex',
  alignItems: 'center',
  position: 'absolute',
  bottom: 0,
  left: 0,
  right: 0,
});
