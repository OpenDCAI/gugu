import { globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type DiffStyleVars = {
  height: number;
  headerH: number;
};

export const diffCardVars = createVariableThemeContract<DiffStyleVars>({
  height: null,
  headerH: null,
});

export const diffRoot = style({ height: diffCardVars.height, overflow: 'hidden' });

// ── DiffHeader ────────────────────────────────────────────────────────────────
//
// @@@no card (Refs #6109,2026-09-22 按 design.md 统一)
//
// diff 是这条对话流里**最后一个还给自己画框**的工具行:execute 早就拆了容器
// (见 `execute.css.ts` 的 @@@no card)、file-op 从来没有过(@@@no resting container)、
// thinking / plan 也都不画。而 design.md 两条同时判它:
//   「**Prefer a change of density over a box.** A field panel (`bg-foreground/[0.025]`)
//     groups machine content with **no border at all**.」
//   Reject:「A card around every section, a box drawn to repair weak hierarchy」
//
// ⇒ 整圈描边与圆角去掉,表头与正文靠**密度**分组:正文一层极淡的底(field panel 那一格),
//   表头仍然只有 hover/press 的状态底。「表头 + 等宽正文」本来就读成一组,
//   这正是 execute 拆容器时写下的那句话。
// ⚠️ `DIFF_VARS.border` 同步改成 0 —— 它是 measure() 的输入(`diffBodyH` 里 `2 * border`),
//   只删样式不改它,引擎会替这两条边各留 1px 没人占的高度。

export const diffHeader = recipe({
  base: {
    height: diffCardVars.headerH,
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    paddingLeft: '8px',
    paddingRight: '8px',
    cursor: 'pointer',
    fontSize: '0.75rem',
    transition: 'background 150ms',
    selectors: {
      // @@@state-ladder-mix 行悬浮走状态档,不再从表面阶梯上挑一级(以前挑的是 bg3,
      // 比同一条对话流里 turn-outcome 挑的 bg2 还深一级)。
      '&:hover': { background: vars.bgHover },
      '&:active': { background: vars.bgPress },
    },
  },
  variants: {
    // 圆角与描边一起撤了(见 @@@no card);两支现在只差「下面有没有正文」这件事本身,
    // 形上不再需要区分 ⇒ 变体保留是为了消费点不动,内容是空的。
    hasBody: {
      true: {},
      false: {},
    },
  },
});

export const diffFileName = style({
  color: vars.fgMuted,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: vars.typeBodyFontSize,
});

export const diffAddsCount = style({
  color: vars.diffAdded,
  flexShrink: 0,
  fontSize: vars.typeBodyFontSize,
});
export const diffDelsCount = style({
  color: vars.diffDeleted,
  flexShrink: 0,
  fontSize: vars.typeBodyFontSize,
});
/**
 * 行尾那一组(失败原因 / 失败记号 / 等授权记号)的第一个靠右。
 *
 * ❌ 用一个 `flex: 1` 的空格把它们顶过去:失败原因那颗片会长进剩下的地方(`givesWayFirst`),
 * 和空格各分一半 —— 原因在半行处就被截,旁边空着半行(#7316)。auto 外边距只拿伸缩分完之后剩下的,
 * 片先长到自己的宽,剩下的才是空白。
 */
export const diffPushRight = style({ marginLeft: 'auto' });
export const diffStatusIcon = style({
  display: 'flex',
  flexShrink: 0,
});
export const diffPermissionIcon = style([
  diffStatusIcon,
  {
    color: vars.fgPermission,
  },
]);
export const diffErrorIcon = style([
  diffStatusIcon,
  {
    color: vars.fgError,
  },
]);

// ── DiffLines body ────────────────────────────────────────────────────────────

/**
 * 正文那一块。@@@no card:不画边、不画圆角 —— 分组靠 design.md 的 field panel 那一格,
 * 一层 `currentColor` 掺到 2.5% 的极淡底。它比表头的 hover 底更淡,所以「指到这一行」
 * 仍然读得出来,而静止时这块只是「密度不同的一片」,不是一张卡。
 */
export const diffBodyCard = style({
  background: 'color-mix(in srgb, currentColor 2.5%, transparent)',
  // Diff rows are measured one source line tall, so wrapping them would make
  // the virtualizer's height contract lie. Keep the source line intact and
  // make the body the scroll container instead of clipping the right side of a
  // long path/command.
  overflowX: 'auto',
  overflowY: 'hidden',
});

/** Per-row classes — keyed by DiffRow type. */
export const diffRowClasses = {
  add: style({
    display: 'flex',
    background: `color-mix(in srgb, ${vars.diffAdded} 10%, transparent)`,
    borderLeft: `3px solid ${vars.diffAdded}`,
  }),
  remove: style({
    display: 'flex',
    background: `color-mix(in srgb, ${vars.diffDeleted} 10%, transparent)`,
    borderLeft: `3px solid ${vars.diffDeleted}`,
  }),
  context: style({
    display: 'flex',
    borderLeft: '3px solid transparent',
  }),
} as const;

export const diffLineContent = style({
  color: vars.fg,
  flex: '0 0 auto',
  minWidth: 'max-content',
  overflow: 'visible',
  paddingLeft: '12px',
  paddingRight: '12px',
});

// ── Shiki line styles ─────────────────────────────────────────────────────────

export const pdiffBody = style({
  position: 'relative',
  width: 'max-content',
  minWidth: '100%',
});

export const pdiffLine = style({
  whiteSpace: 'pre',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  // line-height is set via inline style in Diff.tsx (from theme.fonts.code.lineHeight)
  // so it cannot drift from the measured value via a CSS variable.
});

globalStyle(`${pdiffLine} span`, {
  color: 'var(--shiki-light)',
});

globalStyle(`.emdark ${pdiffLine} span`, {
  color: 'var(--shiki-dark)',
});
