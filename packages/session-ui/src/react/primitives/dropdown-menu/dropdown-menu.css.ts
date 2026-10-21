import { globalStyle, style } from '@vanilla-extract/css';
import { popupShadow, popupSurface } from '@session-ui/styles/recipes/popup-surface.css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
  outline: 'none',
});

// 组成 composer 底排「模型 / 推理强度」那个面板的表面。从前它手抄了一份 `shadow-md` 公式,
// 而同屏的 @提及弹层、agent 选择器用的是 `shadow-sm` + 环 —— 同一个 composer 里三个浮层
// 两种深浅。#3334 §6.1 说浮层只有一种表达,这里改成消费那一份。
//
// 动画选择器与 popupSurface 的那一段只差 `[data-closed]` 多一个 `overflow: hidden`
// (关闭动画期间不让内容溢出),所以组合之后单独保留那一条覆盖,而不是留着整段副本。
export const menuContent = style([
  popupSurface,
  popupShadow,
  {
    zIndex: 50,
    maxHeight: 'var(--available-height)',
    width: 'var(--anchor-width)',
    minWidth: '12rem',
    overflowX: 'hidden',
    overflowY: 'auto',
    padding: '0.25rem',
    selectors: {
      '&[data-closed]': { overflow: 'hidden' },
    },
  },
]);

/**
 * 面板宽度不跟触发器 —— 给「一行左标签、右当前值」那类内容用(composer 的模型/推理强度面板)。
 *
 * `menuContent` 默认 `width: var(--anchor-width)`,那是**下拉框**(值列表贴着输入框同宽)的做法。
 * 菜单不是下拉框:它的行宽由内容决定。composer 底排那颗触发器只有十几个字符宽,面板跟着它,
 * 于是「Reasoning effort」被折成两行、「Opus (1M context)」折行后被面板下沿裁掉 —— 实测就是
 * 这么变形的。这里把宽度交还给内容,并用 `--available-width` 兜住不出屏。
 */
export const contentAutoWidth = style({
  width: 'max-content',
  maxWidth: 'var(--available-width)',
});

export const menuLabel = style({
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  fontSize: tokenVars.textTiny,
  fontWeight: 500,
  color: vars.foregroundMuted,
  selectors: {
    '&[data-inset]': { paddingLeft: '2rem' },
  },
});

export const menuItem = style({
  position: 'relative',
  display: 'flex',
  cursor: 'default',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: tokenVars.radiusSm,
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  fontSize: tokenVars.textSm,
  outline: 'none',
  userSelect: 'none',
  selectors: {
    '&:focus': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&[data-inset]': { paddingLeft: '2rem' },
    '&[data-variant="destructive"]': { color: vars.foregroundDestructive },
    '&[data-variant="destructive"]:focus': {
      // @@@state-ladder-mix 危险项的高亮底也走状态阶梯(surfaceDestructiveHover),
      // 与 ghost+destructive 按钮同一格;backgroundDestructive 是「表面色」不是「状态色」,
      // 用在这里比同一张菜单里别的项深一大截。
      backgroundColor: vars.surfaceDestructiveHover,
      color: vars.foregroundDestructive,
    },
    '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
  },
});
globalStyle(`${menuItem} svg`, { pointerEvents: 'none', flexShrink: 0 });
globalStyle(`${menuItem} svg:not([class*='size-'])`, { width: '1rem', height: '1rem' });

export const menuSubTrigger = style({
  display: 'flex',
  cursor: 'default',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: tokenVars.radiusSm,
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  fontSize: tokenVars.textSm,
  outline: 'none',
  userSelect: 'none',
  selectors: {
    '&:focus': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&[data-inset]': { paddingLeft: '2rem' },
    // @@@state-ladder-mix 子菜单开着 = 持久选中语义,比键盘/鼠标高亮(hover 档)深一档,
    // 否则「哪一项把子菜单展开着」与「光标只是路过」看起来一样。
    '&[data-popup-open]': { backgroundColor: vars.surfaceSelected, color: vars.foreground },
    '&[data-open]': { backgroundColor: vars.surfaceSelected, color: vars.foreground },
  },
});
globalStyle(`${menuSubTrigger} svg`, { pointerEvents: 'none', flexShrink: 0 });
globalStyle(`${menuSubTrigger} svg:not([class*='size-'])`, { width: '1rem', height: '1rem' });

export const menuCheckboxItem = style({
  position: 'relative',
  display: 'flex',
  cursor: 'default',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: tokenVars.radiusSm,
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  paddingRight: '2rem',
  paddingLeft: '0.5rem',
  fontSize: tokenVars.textSm,
  outline: 'none',
  userSelect: 'none',
  color: vars.foregroundMuted,
  selectors: {
    '&[data-checked]': { color: vars.foreground, backgroundColor: vars.surfaceSelected },
    '&:focus': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&[data-inset]': { paddingLeft: '2rem' },
    '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
  },
});
globalStyle(`${menuCheckboxItem} svg`, { pointerEvents: 'none', flexShrink: 0 });
globalStyle(`${menuCheckboxItem} svg:not([class*='size-'])`, { width: '1rem', height: '1rem' });

export const menuRadioItem = style({
  position: 'relative',
  display: 'flex',
  cursor: 'default',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: tokenVars.radiusSm,
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  paddingRight: '2rem',
  paddingLeft: '0.5rem',
  fontSize: tokenVars.textSm,
  outline: 'none',
  userSelect: 'none',
  color: vars.foregroundMuted,
  selectors: {
    '&[data-checked]': { color: vars.foreground, backgroundColor: vars.surfaceSelected },
    '&:focus': { backgroundColor: vars.surfaceHover, color: vars.foreground },
    '&[data-inset]': { paddingLeft: '2rem' },
    '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
  },
});
globalStyle(`${menuRadioItem} svg`, { pointerEvents: 'none', flexShrink: 0 });
globalStyle(`${menuRadioItem} svg:not([class*='size-'])`, { width: '1rem', height: '1rem' });

export const menuItemIndicator = style({
  pointerEvents: 'none',
  position: 'absolute',
  right: '0.5rem',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
});

export const menuSeparator = style({
  marginLeft: '-0.25rem',
  marginRight: '-0.25rem',
  marginTop: '0.25rem',
  marginBottom: '0.25rem',
  height: '1px',
  backgroundColor: vars.border,
});

/** Overrides the default anchor-width sizing for sub-menus so they size to content. */
export const subContentOverride = style({
  width: 'auto',
  minWidth: '6rem', // 96px
});

/**
 * 快捷键提示 —— mono。它是**你按下去的那串键**,design.md 给 mono 的工作正是这一类
 * (「the thing you type or install … an identifier」)。
 *
 * 2026-09-22:原来这里用 `letterSpacing: 0.1em` 把普通字体撑开来冒充等宽 —— 撑开的是
 * 字距不是字宽,`⌘K` 与 `⌘W` 仍然不一样长,一列快捷键右边缘照样参差。
 */
export const menuShortcut = style({
  marginLeft: 'auto',
  fontFamily: tokenVars.fontMono,
  fontSize: tokenVars.textTiny,
  color: vars.foregroundMuted,
  // When the parent menu item is focused, shortcut adapts to foreground color
  selectors: {
    '[data-slot="dropdown-menu-item"]:focus &': { color: vars.foreground },
  },
});
