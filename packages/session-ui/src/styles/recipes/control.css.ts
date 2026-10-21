/**
 * controlVariants — Vanilla Extract recipe replacing the CVA controlVariants.
 *
 * Public API is identical: call controlVariants({ variant, tone, size, icon })
 * and receive a class-name string. Consumers (Button, Toggle, Tabs, etc.) import
 * the re-exported wrapper at recipes/control so no import path changes are needed.
 *
 * RecipeVariants<typeof controlVariants> replaces VariantProps<typeof controlVariants>.
 */

import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import type { RecipeVariants } from '@vanilla-extract/recipes';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

// Pre-create base style so we can attach globalStyle child selectors
const controlBase = style({
  display: 'inline-flex',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: tokenVars.radiusMd,
  border: '1px solid transparent',
  backgroundClip: 'padding-box',
  fontSize: tokenVars.textSm,
  fontWeight: 400,
  whiteSpace: 'nowrap',
  transition: 'all 150ms',
  outline: 'none',
  userSelect: 'none',
  selectors: {
    '&:disabled': { pointerEvents: 'none', opacity: 0.5 },
    '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
  },
});
globalStyle(`${controlBase} svg`, { pointerEvents: 'none', flexShrink: 0 });
globalStyle(`${controlBase} svg:not([class*='size-'])`, { width: '1rem', height: '1rem' });

// Pre-create sm size style for its svg override
const smSizeBase = style({
  height: '1.5rem',
  gap: '0.25rem',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  // ❌ 不覆盖字号:size 只管几何。主 app 的 Button 原语所有尺寸同一个 --font-body,
  // 这里跟着继承 controlBase 的 textSm —— 一个控件族两种字号,读起来就是两个东西。
  borderRadius: tokenVars.radiusMd,
});
globalStyle(`${smSizeBase} svg:not([class*='size-'])`, { width: '0.75rem', height: '0.75rem' });

export const controlVariants = recipe({
  base: controlBase,

  variants: {
    variant: {
      ghost: {
        // Transparent at rest: blend into the surface behind us, only tinting
        // on interaction via the surface cascade vars below.
        backgroundColor: 'transparent',
        color: vars.foregroundMuted,
        selectors: {
          '&:hover': { backgroundColor: vars.surfaceHover, color: vars.foreground },
          '&[aria-expanded="true"]': {
            backgroundColor: vars.surfaceSelected,
            color: vars.foreground,
          },
          '&[aria-pressed="true"]': {
            backgroundColor: vars.surfaceSelected,
            color: vars.foreground,
          },
          '&[aria-selected="true"]': {
            backgroundColor: vars.surfaceSelected,
            color: vars.foreground,
          },
          '&[data-pressed]': { backgroundColor: vars.surfaceSelected, color: vars.foreground },
          '&[data-selected]': { backgroundColor: vars.surfaceSelected, color: vars.foreground },
          '&[data-popup-open]': { backgroundColor: vars.surfaceSelected, color: vars.foreground },
          '&[data-active="true"]': {
            backgroundColor: vars.surfaceSelected,
            color: vars.foreground,
          },
          // @@@state-ladder-mix 真·按下态。用 CSS `:active` 而不是 `data-pressed` —— Base UI 的
          // data-pressed 在 Toggle 上表达的是「开着」(持久选中语义),在这里复用会把两种语义混成
          // 一个视觉。`:active` 只在鼠标/手指真按住时命中,桌面与触屏都有,正是 spec 要的那一档。
          // 写在选择器组最后 ⇒ 同特异度下按下压过 hover/selected,松手立刻回落。
          // 兜底给 surfaceSelected:脱离咕咕皮肤(独立 storybook)时 --em-surface-press 未定义。
          '&:active:not(:disabled):not([data-disabled])': {
            backgroundColor: `var(--em-surface-press, ${vars.surfaceSelected})`,
            color: vars.foreground,
          },
        },
      },
      primary: {
        backgroundColor: vars.primaryButtonBackground,
        color: vars.primaryButtonForeground,
        borderColor: vars.primaryButtonBorder,
        selectors: {
          // @@@state-ladder-mix 实色填充钮的反馈走**透明度阶梯**,不换底色、不缩放
          // (product spec「反馈的克制」;与咕咕主体的 .gg-fill 同一配方)。
          // 以前 hover 换成 primaryButtonBackgroundHover 是另一种色,与主体那半边对不上。
          '&:hover': { opacity: 0.88 },
          '&[aria-expanded="true"]': { opacity: 0.88 },
          '&[data-popup-open]': { opacity: 0.88 },
          '&[data-active="true"]': { opacity: 0.88 },
          '&:active:not(:disabled):not([data-disabled])': { opacity: 0.78 },
        },
      },
      secondary: {
        backgroundColor: vars.surfaceBaseEmphasis,
        color: vars.foregroundMuted,
        selectors: {
          // @@@state-ladder-mix 与 ghost/primary 同批补上真按下态(`:active`)。
          // 消费者之一是 permission-band 的 Allow/Deny(SplitButton variant="secondary")。
          '&:active:not(:disabled):not([data-disabled])': {
            backgroundColor: `var(--em-surface-press, ${vars.surfaceBaseEmphasisSelected})`,
          },
          '&:hover': {
            backgroundColor: vars.surfaceBaseEmphasisHover,
            color: vars.foregroundMuted,
          },
          '&[aria-expanded="true"]': {
            backgroundColor: vars.surfaceBaseEmphasisSelected,
            color: vars.foregroundMuted,
          },
          '&[aria-pressed="true"]': {
            backgroundColor: vars.surfaceBaseEmphasisSelected,
            color: vars.foregroundMuted,
          },
          '&[aria-selected="true"]': {
            backgroundColor: vars.surfaceBaseEmphasisSelected,
            color: vars.foregroundMuted,
          },
          '&[data-pressed]': {
            backgroundColor: vars.surfaceBaseEmphasisSelected,
            color: vars.foregroundMuted,
          },
          '&[data-selected]': {
            backgroundColor: vars.surfaceBaseEmphasisSelected,
            color: vars.foregroundMuted,
          },
          '&[data-popup-open]': {
            backgroundColor: vars.surfaceBaseEmphasisSelected,
            color: vars.foregroundMuted,
          },
          '&[data-active="true"]': {
            backgroundColor: vars.surfaceBaseEmphasisSelected,
            color: vars.foregroundMuted,
          },
        },
      },
    },

    tone: {
      neutral: {},
      destructive: {},
      warning: {},
      info: {},
      success: {},
    },

    size: {
      base: {
        height: '2rem',
        gap: '0.375rem',
        paddingLeft: '0.625rem',
        paddingRight: '0.625rem',
      },
      sm: smSizeBase,
      link: {
        height: 'auto',
        gap: '0.25rem',
        border: 'none',
        backgroundColor: 'transparent',
        padding: 0,
        color: vars.foreground,
        selectors: {
          '&:hover': {
            textDecoration: 'underline',
            textUnderlineOffset: '2px',
          },
        },
      },
    },

    icon: {
      true: {},
      false: {},
    },
  },

  compoundVariants: [
    // ghost + link: keep transparent background across all interaction states so the ghost
    // hover colour never bleeds through. Compound variants emit after regular variants, giving
    // them the winning source-order position at equal specificity.
    {
      variants: { variant: 'ghost', size: 'link' },
      style: {
        backgroundColor: 'transparent',
        selectors: {
          '&:hover': { backgroundColor: 'transparent' },
          '&[aria-expanded="true"]': { backgroundColor: 'transparent' },
          '&[aria-pressed="true"]': { backgroundColor: 'transparent' },
          '&[aria-selected="true"]': { backgroundColor: 'transparent' },
          '&[data-pressed]': { backgroundColor: 'transparent' },
          '&[data-selected]': { backgroundColor: 'transparent' },
          '&[data-popup-open]': { backgroundColor: 'transparent' },
          '&[data-active="true"]': { backgroundColor: 'transparent' },
        },
      },
    },
    // ghost + destructive
    {
      variants: { variant: 'ghost', tone: 'destructive' },
      style: {
        color: vars.foregroundDestructive,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceDestructiveHover,
            color: vars.foregroundDestructive,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceDestructiveSelected },
        },
      },
    },
    // ghost + warning
    {
      variants: { variant: 'ghost', tone: 'warning' },
      style: {
        color: vars.foregroundWarning,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceWarningHover,
            color: vars.foregroundWarning,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceWarningSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceWarningSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceWarningSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceWarningSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceWarningSelected },
        },
      },
    },
    // ghost + info
    {
      variants: { variant: 'ghost', tone: 'info' },
      style: {
        color: vars.foregroundInfo,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceInfoHover,
            color: vars.foregroundInfo,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceInfoSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceInfoSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceInfoSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceInfoSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceInfoSelected },
        },
      },
    },
    // ghost + success
    {
      variants: { variant: 'ghost', tone: 'success' },
      style: {
        color: vars.foregroundSuccess,
        selectors: {
          '&:hover': {
            backgroundColor: vars.surfaceSuccessHover,
            color: vars.foregroundSuccess,
          },
          '&[data-active="true"]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[aria-pressed="true"]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[aria-selected="true"]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceSuccessSelected },
          '&[data-popup-open]': { backgroundColor: vars.surfaceSuccessSelected },
        },
      },
    },
    // primary + destructive
    {
      variants: { variant: 'primary', tone: 'destructive' },
      style: {
        backgroundColor: vars.backgroundDestructive,
        borderColor: vars.borderDestructive,
        color: vars.foregroundDestructive,
        selectors: {
          '&:hover': { backgroundColor: vars.surfaceDestructiveHover },
          '&[data-active="true"]': { backgroundColor: vars.surfaceDestructiveSelected },
          '&[data-pressed]': { backgroundColor: vars.surfaceDestructiveSelected },
        },
      },
    },
    // icon + base → 2rem square
    {
      variants: { icon: true, size: 'base' },
      style: { width: '2rem', height: '2rem', paddingLeft: 0, paddingRight: 0 },
    },
    // icon + sm → 1.5rem square
    {
      variants: { icon: true, size: 'sm' },
      style: { width: '1.5rem', height: '1.5rem', paddingLeft: 0, paddingRight: 0 },
    },
  ],

  defaultVariants: {
    variant: 'ghost',
    tone: 'neutral',
    size: 'base',
    icon: false,
  },
});

export type ControlVariantProps = NonNullable<RecipeVariants<typeof controlVariants>>;
