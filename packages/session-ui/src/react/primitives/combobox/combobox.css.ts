import { globalStyle, style } from '@vanilla-extract/css';
import { svgDefaultSize } from '@session-ui/styles/effects/svg-helpers.css';
import { menuItemBase } from '@session-ui/styles/recipes/menu-item.css';
import { popupSurface, popupShadow } from '@session-ui/styles/recipes/popup-surface.css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const positioner = style({
  isolation: 'isolate',
  zIndex: 50,
});

export const comboboxTrigger = style([svgDefaultSize, {}]);

export const comboboxContent = style([
  popupSurface,
  popupShadow,
  {
    maxHeight: 'var(--available-height)',
    width: 'var(--anchor-width)',
    maxWidth: 'var(--available-width)',
    minWidth: 'var(--anchor-width)',
    overflow: 'hidden',
    padding: '2px',
    // @@@combobox-clamped-footer — 高度被 maxHeight 钳住时,收缩必须落在滚动列表上,
    // 不能是 overflow:hidden 把尾部(页脚,如模型菜单的思考滑杆)静默裁掉。
    // 弹层 = flex 列:头/页脚按内容高,唯一 min-height:0 的列表滚动区吃掉全部收缩
    // (ComboboxList 的 -2.25rem 预留只是旧保险,真正的分配由这里管)。
    display: 'flex',
    flexDirection: 'column',
  },
]);

/**
 * Outer wrapper that ScrollContainer renders — position context for the fade overlay.
 * 弹层钳制时这一层是唯一允许被压缩的 flex 项:flex-basis auto(不钳时按内容高),
 * min-height:0(钳时能缩到 0 以下由内部滚动接住),自身再当 flex 列让 viewport 跟着缩。
 */
export const comboboxListScroller = style({
  flex: '1 1 auto',
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column',
});

/**
 * Applied to the scroll viewport inside ScrollContainer.
 * overscrollBehavior must be on the actual scrolling element.
 * flex 链的最后一环:外层被压缩时 viewport 同步缩(ScrollContainer 的 maxHeight
 * 仍是不钳时的上限),溢出走它自己的 overflow-y 滚动。
 */
export const comboboxListViewport = style({
  overscrollBehavior: 'contain',
  flex: '1 1 auto',
  minHeight: 0,
});

export const comboboxList = style({
  scrollPaddingTop: '2px',
  scrollPaddingBottom: '2px',
});

export const comboboxItem = style([
  menuItemBase({ trailingIndicator: true, fullWidth: true }),
  {
    selectors: {
      '&[data-highlighted]:not([data-selected])': { backgroundColor: vars.surfaceHover },
      '&[data-selected]': { backgroundColor: vars.surfaceSelected },
      '&[data-highlighted]': { color: vars.foreground },
      '&[data-disabled]': { pointerEvents: 'none', opacity: 0.5 },
    },
  },
]);

export const comboboxItemIndicator = style({
  pointerEvents: 'none',
  position: 'absolute',
  right: '0.5rem',
  display: 'flex',
  width: '0.875rem',
  height: '0.875rem',
  alignItems: 'center',
  justifyContent: 'center',
});

export const comboboxLabel = style({
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  fontSize: tokenVars.textTiny,
  color: vars.foregroundMuted,
});

export const comboboxEmpty = style({
  display: 'none',
  width: '100%',
  justifyContent: 'center',
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
  textAlign: 'center',
  fontSize: tokenVars.textSm,
  color: vars.foregroundMuted,
  selectors: {
    // show when data-empty is on the parent popup
    '[data-slot="combobox-content"][data-empty] &': {
      display: 'flex',
    },
  },
});

export const comboboxSeparator = style({
  marginLeft: '-0.25rem',
  marginRight: '-0.25rem',
  marginTop: '0.25rem',
  marginBottom: '0.25rem',
  height: '1px',
  backgroundColor: vars.border,
});

export const comboboxChips = style({
  display: 'flex',
  minHeight: '2.25rem',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  border: `1px solid ${vars.border}`,
  backgroundColor: 'transparent',
  backgroundClip: 'padding-box',
  paddingLeft: '0.625rem',
  paddingRight: '0.625rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  fontSize: tokenVars.textSm,
  // ❌ 静止态不画投影(2026-09-22,按 design.md):这里原来是 `0 1px 2px rgba(0,0,0,0.05)`。
  // 「**Shadows are zeroed globally. Only a floating surface may lift.**」—— 触发器是一件
  // 钉在版面上的控件,不是浮层;且它同一条边上已有 1px border,校验态还要再加一道 3px 环,
  // 三者共边正是 design.md 点名禁的那一手。层级由描边 + 底色表达,投影这一层是多的。
  transition: 'color 150ms, box-shadow 150ms',
  selectors: {
    '&:has([aria-invalid="true"])': {
      borderColor: vars.borderDestructive,
      boxShadow: `0 0 0 3px color-mix(in srgb, ${vars.borderDestructive} 20%, transparent)`,
    },
    '&:has([data-slot="combobox-chip"])': {
      paddingLeft: '0.375rem',
    },
  },
});

export const comboboxChip = style({
  display: 'flex',
  height: '1.375rem',
  width: 'fit-content',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '0.25rem',
  borderRadius: tokenVars.radiusSm,
  backgroundColor: vars.surfaceHover,
  paddingLeft: '0.375rem',
  paddingRight: '0.375rem',
  fontSize: tokenVars.textSm,
  fontWeight: 500,
  whiteSpace: 'nowrap',
  color: vars.foreground,
  selectors: {
    '&:has([disabled])': { pointerEvents: 'none', cursor: 'not-allowed', opacity: 0.5 },
    '&:has([data-slot="combobox-chip-remove"])': { paddingRight: 0 },
  },
});

export const comboboxChipRemove = style({
  marginLeft: '-0.25rem',
  opacity: 0.5,
  selectors: {
    '&:hover': { opacity: 1 },
  },
});

export const comboboxChipsInput = style({
  minWidth: '4rem',
  flex: 1,
  outline: 'none',
});

/**
 * Applied to the trigger InputGroupButton inside ComboboxInput.
 * Hides when a sibling combobox-clear button is present; clears pressed bg.
 */
export const triggerButtonHideIfClear = style({
  selectors: {
    '&[data-pressed]': { backgroundColor: 'transparent' },
  },
});
globalStyle(
  `[data-slot="input-group"]:has([data-slot="combobox-clear"]) ${triggerButtonHideIfClear}`,
  { display: 'none' }
);
