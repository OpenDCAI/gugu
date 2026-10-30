import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import {
  durFast,
  durMed,
  easeStandard,
  kfFadeIn,
  kfFadeOut,
  kfPopupIn,
  kfPopupOut,
} from '@session-ui/styles/effects/animations.css';
import { popupShadow } from '@session-ui/styles/recipes/popup-surface.css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

/** Modal scrims share the host token and its theme-specific opacity. */
export const overlay = style({
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  backgroundColor: 'var(--bg-overlay-modal)',
  selectors: {
    '&[data-open]': { animation: `${kfFadeIn} ${durMed} ${easeStandard} both` },
    '&[data-closed]': { animation: `${kfFadeOut} ${durFast} ${easeStandard} both` },
  },
});

/** Full-viewport grid that centers the popup without using transform on the popup itself. */
export const positioner = style({
  position: 'fixed',
  inset: 0,
  zIndex: 50,
  display: 'grid',
  placeItems: 'center',
  padding: '1rem',
  pointerEvents: 'none',
});

export const content = recipe({
  // 对话框也是浮层(#3334 §6.1 的那张表里就有它),所以走同一份表达。
  // ❌ 不组合 popupSurface:居中的模态没有 `[data-side]`,那 8 条按边分支的入场动画在它身上
  // 一条都不会命中,搬进来只是噪声;它有自己的 open/closed 两条。
  base: [
    popupShadow,
    {
      pointerEvents: 'auto',
      zIndex: 50,
      display: 'flex',
      maxHeight: '100%',
      width: '100%',
      maxWidth: '100%',
      flexDirection: 'column',
      overflow: 'hidden',
      // design.md shape 表:dialog / toast / floating card = --radius-xl(12px)。
      borderRadius: tokenVars.radiusXl,
      backgroundColor: vars.surface,
      fontSize: tokenVars.textSm,
      color: vars.foreground,
      outline: 'none',
      selectors: {
        '&[data-open]': { animation: `${kfPopupIn} ${durMed} ${easeStandard} both` },
        '&[data-closed]': { animation: `${kfPopupOut} ${durFast} ${easeStandard} both` },
      },
    },
  ],
  variants: {
    size: {
      xs: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '20rem' } } },
      sm: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '24rem' } } },
      md: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '32rem' } } },
      lg: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '42rem' } } },
      xl: { '@media': { 'screen and (min-width: 640px)': { maxWidth: '80vw', height: '80vh' } } },
    },
  },
  defaultVariants: { size: 'md' },
});

export const header = style({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: '0.5rem',
  padding: '1rem',
});

export const headerInner = style({
  display: 'flex',
  minWidth: 0,
  flexDirection: 'column',
  gap: '0.25rem',
});

export const footer = style({
  display: 'flex',
  flexShrink: 0,
  flexDirection: 'column-reverse',
  gap: '0.5rem',
  borderTop: `1px solid ${vars.border}`,
  padding: '0.75rem',
  backgroundColor: vars.surfaceBaseEmphasis,
  '@media': {
    '(min-width: 640px)': {
      flexDirection: 'row',
      justifyContent: 'flex-end',
    },
  },
});

export const title = style({
  fontSize: tokenVars.textSm,
  letterSpacing: '-0.015em',
  color: vars.foreground,
});

export const body = style({
  display: 'flex',
  width: '100%',
  flexDirection: 'column',
  gap: '0.5rem',
  padding: '1rem',
  paddingTop: 0,
  outline: 'none',
  selectors: {
    '&:focus-visible': { outline: 'none' },
  },
});

export const closeButtonOverride = style({
  marginTop: '-0.25rem',
  marginRight: '-0.25rem',
  flexShrink: 0,
  color: vars.foregroundMuted,
  selectors: {
    '&:hover': { color: vars.foreground },
  },
});
