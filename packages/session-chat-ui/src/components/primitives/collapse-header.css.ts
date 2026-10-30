import { style } from '@vanilla-extract/css';
import { sx } from '@session-chat/styles/sprinkles.css';
import { vars } from '@session-chat/styles/theme.css';

export const collapseRow = sx({
  display: 'flex',
  alignItems: 'center',
  gap: '1.5',
  color: 'fgPassive',
  userSelect: 'none',
});

export const collapseRowHover = style({
  selectors: {
    '&:hover': { color: vars.fgMuted },
  },
});

/**
 * What a row looks like when it answers the pointer.
 *
 * The pointer cursor and the hover response live here rather than on the base
 * row because they are the *promise* half of a disclosure: a row that hides
 * nothing must look exactly like a row that was never collapsible. Tool rows and
 * subagent headers wear this same class, so every collapsible surface in the
 * transcript answers the pointer alike and there is only one place to change it.
 */
export const collapsibleRow = style([collapseRowHover, { cursor: 'pointer' }]);

/** Combined class for the header row element. */
export const collapseHeader = style([collapseRow, { fontSize: vars.typeBodyFontSize }]);

export const chevron = style({
  display: 'inline-block',
  flexShrink: 0,
  width: 12, height: 12, lineHeight: '12px', textAlign: 'center',
  // @@@type-chrome (Refs #6104) — 这个字号量的是**箭头字形本身**的大小,走 chrome 的最小那一档(10)。
  fontSize: vars.typeChromeMicroFontSize,
  transition: 'transform 150ms ease-out',
});

export const chevronExpanded = style({
  transform: 'rotate(90deg)',
});

export const collapseStatusError = style({
  marginLeft: 'auto',
  display: 'flex',
  color: vars.fgError,
});

export const collapseStatusPermission = style({
  marginLeft: 'auto',
  display: 'flex',
  color: vars.fgPermission,
});

/**
 * 表头那个标签,一行到底、挤不下就省略号收尾。
 *
 * 表头是**定高且 clip** 的(`ROW_H` 32px):标签一旦折行,第二行就落在裁切线以外 ——
 * 读者看到的是半个字,而 `offsetHeight` 照样读 32,高度契约一声不吭。#4981 真机上量到过
 * 同一件事的两副长相:中文标签被挤成「执 / 行」竖着摞(owner 验收截图 2026-09-04),
 * 英文标签在空格处折行、把行撑到 34px 顶出裁切线 1px(card-rows 契约判红 2026-09-05)。
 *
 * 四条声明各自担什么,是 2026-09-05 在 chromium 上逐条变异量出来的,不是推的:
 *
 * · `whiteSpace: nowrap` —— **承重且有判据**。去掉它,execute 那条 CJK 判据立刻从 20 变
 *   40(标签两行),card-rows 同时读出 33px in 32px。
 *
 * · `minWidth: 0` 与 `overflow: hidden` —— **一对,干的是同一件事**:把这个 flex item 的
 *   自动最小尺寸清零,让不折行的标签仍然可以被压扁。⚠️ **单独去掉任何一个都不会红**
 *   (两次变异都绿),因为按 flex 规范 `overflow` 非 `visible` 本身就把自动最小尺寸置零;
 *   **两个一起去掉**才红,而且红成那个熟悉的样子:退出状态被顶出行右边缘 274px。
 *   ⇒ 两个都留着是**冗余而非重复**:留一个也能跑,但那样下一个人删掉它时没有任何东西
 *   会响。这一格的判据只覆盖「两个都没了」,单删的那两种情形**没有判据**,知道就行,
 *   别当它被守着。
 *
 * · `textOverflow: ellipsis` —— **纯观感,没有判据**。去掉它文字改成硬裁而不是「…」,
 *   全套契约照样绿(变异验过)。写在这里是因为半个字比省略号更像坏了,不是因为它被守着。
 */
export const collapseHeaderLabel = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});
