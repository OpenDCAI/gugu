import { globalStyle, keyframes, style } from '@vanilla-extract/css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const pillWrapper = style({
  display: 'inline-block',
  verticalAlign: 'baseline',
});

export const pill = style({
  position: 'relative',
  display: 'inline-flex',
  cursor: 'default',
  userSelect: 'none',
  alignItems: 'center',
  gap: '0.25rem',
  borderRadius: tokenVars.radiusSm,
  paddingLeft: '0.25rem',
  paddingRight: '0.25rem',
  paddingTop: '0.125rem',
  paddingBottom: '0.125rem',
  fontSize: tokenVars.textSm,
  fontWeight: 500,
  color: vars.foreground,
  verticalAlign: 'baseline',
});

export const pillPlain = style({
  display: 'inline',
  gap: 0,
  borderRadius: 0,
  padding: 0,
  fontSize: 'inherit',
  fontWeight: 'inherit',
});

const pendingPulse = keyframes({
  '0%, 100%': { opacity: 1 },
  '50%': { opacity: 0.55 },
});

export const pillPending = style({
  animation: `${pendingPulse} 1.4s ease-in-out infinite`,
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      animation: 'none',
    },
  },
});

export const pillIconArea = style({
  position: 'relative',
  display: 'flex',
  width: '0.875rem',
  height: '0.875rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
});

export const pillPlainIconArea = style({
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
});

export const pillAgentIconArea = style({
  position: 'relative',
  display: 'inline-flex',
  width: '0.875rem',
  height: '0.875rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  verticalAlign: 'middle',
});

export const pillAgentIcon = style({
  display: 'inline-flex',
  width: '100%',
  height: '100%',
  alignItems: 'center',
  justifyContent: 'center',
  overflow: 'hidden',
});

globalStyle(`${pillAgentIcon} > img, ${pillAgentIcon} > svg`, {
  width: '100%',
  height: '100%',
  objectFit: 'contain',
});

export const pillRemoveBtn = style({
  position: 'absolute',
  inset: 0,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: tokenVars.radiusSm,
  backgroundColor: vars.surfaceHover,
  opacity: 0,
  transition: 'opacity 150ms',
  selectors: {
    [`${pill}:hover &`]: { opacity: 1 },
    '&:hover': { backgroundColor: vars.surfaceSelected },
  },
});

/**
 * 斜杠片前缀那枚 `/` 字形。
 *
 * ⚠️ 2026-09-22:原来写在 `slash-command-pill.tsx` 的行内 style 里
 * (`{ fontSize: '0.75rem', fontWeight: 600, lineHeight: 1 }`) —— 0.75rem 就是 12px,
 * 而咕咕字阶是 11/13/15/17/20,没有 12(owner 2026-09-03 点名消灭的那一档)。
 * 收进 `textTiny`(11px),顺便把这三个声明从 JSX 里挪回样式层。
 */
export const pillSigil = style({
  fontSize: tokenVars.textTiny,
  fontWeight: 600,
  lineHeight: 1,
});

export const pillName = style({
  maxWidth: '200px',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const pillAnnotation = style({ marginInlineStart: '0.375rem', fontSize: tokenVars.textTiny, color: vars.foregroundMuted });
