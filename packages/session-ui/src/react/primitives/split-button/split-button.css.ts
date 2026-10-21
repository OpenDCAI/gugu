import { style } from '@vanilla-extract/css';

export const splitButtonRoot = style({
  display: 'inline-flex',
  flexShrink: 0,
  alignItems: 'stretch',
});

/** Primary face: right side rounded corners removed to butt against chevron. */
export const splitButtonFace = style({
  minWidth: 0,
  maxWidth: 'min(16rem, 40vw)',
  overflow: 'hidden',
  borderTopRightRadius: 0,
  borderBottomRightRadius: 0,
  paddingRight: '0.5rem',
  paddingLeft: '0.75rem',
});

export const splitButtonLabel = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

export const splitButtonMenuLabel = style({
  minWidth: 0,
  maxWidth: 'min(28rem, 70vw)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

/** Chevron face: left side rounded corners removed to butt against primary face. */
export const splitButtonChevronFace = style({
  flexShrink: 0,
  borderTopLeftRadius: 0,
  borderBottomLeftRadius: 0,
});

/**
 * Left border separator between primary face and chevron in primary variant.
 *
 * ⚠️ 2026-09-22 按 design.md 统一:从固定白 `rgba(255,255,255,0.2)` 换成 `currentColor` 掺透明。
 * 固定白只在「主按钮底色是深色」时成立 —— 而主按钮的墨色底在明暗两套里是对调的
 * (`--primary-button-background` 浅色下是墨、暗色下是浅),于是暗色主题里这条缝是
 * **白线画在浅底上**,等于没有。掺 currentColor 的式子两侧都成立,且不写死任何颜色。
 */
export const chevronBorderLeft = style({
  borderLeft: `1px solid color-mix(in srgb, currentColor 20%, transparent)`,
});
