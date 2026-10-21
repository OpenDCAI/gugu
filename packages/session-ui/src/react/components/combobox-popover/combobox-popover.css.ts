import { globalStyle, style } from '@vanilla-extract/css';
import { svgDefaultSize } from '@session-ui/styles/effects/svg-helpers.css';
import { fieldShellBase } from '@session-ui/styles/recipes/field-shell.css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

export const trigger = style({
  display: 'flex',
  height: '1.75rem',
  minWidth: 0,
  alignItems: 'center',
  gap: '0.375rem',
  borderRadius: tokenVars.radiusMd,
  border: '1px solid transparent',
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  fontSize: tokenVars.textSm,
  color: vars.foreground,
  outline: 'none',
  selectors: {
    // @@@state-ladder-mix 悬浮走 hover 档、开着走 selected 档。两者以前同取 surfaceBaseSelected,
    // 于是悬浮过深、且开没开分不出来(同一排里的 `+` 用的是 surfaceHover,深浅对不上)。
    '&:hover': { backgroundColor: vars.surfaceHover },
    '&[data-popup-open]': { backgroundColor: vars.surfaceSelected },
    '&:active:not(:disabled)': {
      backgroundColor: `var(--em-surface-press, ${vars.surfaceSelected})`,
    },
    '&[data-disabled], &:disabled': { cursor: 'not-allowed', opacity: 0.6 },
  },
});

export const triggerLabel = style({
  display: 'inline-flex',
  minWidth: 0,
  flex: 1,
  alignItems: 'center',
  lineHeight: 1,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left',
});

export const triggerChevron = style({
  flexShrink: 0,
  width: '0.75rem',
  height: '0.75rem',
  color: vars.foregroundMuted,
});

/**
 * @@@combobox-chevron-size — 上面那 12px 曾经是**死的**,必须靠这条才落地。
 *
 * `comboboxTrigger` 组进了 `svgDefaultSize`(见 `react/primitives/combobox/combobox.css.ts`),
 * 而它带一条全局规则 `${svgDefaultSize} svg:not([class*='size-']) { width:1rem }`。
 * 那条是「一个类 + 一个元素」= (0,1,1),上面这条只有「一个类」= (0,1,0) —— 特异性输,
 * 于是**声明写 0.75rem、渲染出来一直是 16px**,无报错无警告。
 * (2026-09-05 MBP 真机量:composer 底排三枚同形箭头,走这个组件的那枚 16,另两枚 12。)
 *
 * 那条 helper 的 `:not([class*='size-'])` 本意是「图标自己声明了尺寸就别管它」,但它认的是
 * Tailwind 的 `size-*` 类名;vanilla-extract 生成的类名里永远不含 `size-` 子串,所以在这个包里
 * 那道闸**结构上就看不见**组件自己的声明。❌ 别去改 helper 的 `:not()`(会波及全 app 的图标),
 * ❌ 也别给这枚箭头硬塞一个含 `size-` 的类名(靠生成类名的子串,下次改名就断)。
 * 这里只把同一个值用 (0,2,1) 再说一遍,作用域仅限这枚箭头。
 *
 * owner 2026-09-05 拍板:三枚统一 12(也就是三处源码本来都写着的那个数)。
 */
globalStyle(`${svgDefaultSize} svg${triggerChevron}`, {
  width: '0.75rem',
  height: '0.75rem',
});

/** Default min-width for the combobox dropdown content. */
export const contentMinWidth = style({ minWidth: '11.25rem' }); // 180px

/**
 * Input-appearance trigger layout.
 * Composed with fieldShellBase for the full input look (border, bg, focus ring).
 */
export const triggerInput = [
  fieldShellBase,
  style({
    display: 'flex',
    width: '100%',
    height: '2rem',
    alignItems: 'center',
    gap: '0.375rem',
    paddingLeft: '0.625rem',
    paddingRight: '0.375rem',
    fontSize: tokenVars.textSm,
    selectors: {
      '&[data-placeholder]': { color: vars.foregroundPassive },
    },
  }),
] as const;
