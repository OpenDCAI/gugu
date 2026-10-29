import { globalStyle, keyframes } from '@vanilla-extract/css';
import { vars } from './theme.css';

// Match the chat host's source-message treatment, including standalone session pages.
const flash = keyframes({
  '0%, 18%': {
    background: `var(--accent-tint-row, ${vars.bgSelected})`,
    boxShadow: `0 0 0 2px var(--accent-glow-soft, color-mix(in oklab, ${vars.fg} 12%, transparent))`,
  },
  '100%': { background: 'transparent', boxShadow: '0 0 0 2px transparent' },
});

globalStyle('.msg-src-flash', {
  borderRadius: `var(--radius-control, ${vars.radiusMd})`,
  animation: `${flash} 1.4s ease-out`,
});
