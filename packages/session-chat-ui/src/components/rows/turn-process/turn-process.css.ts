import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/**
 * Root of the turn-process header row. Clipped to the engine height like every
 * other engine-height row root so a transient measure/render desync degrades
 * to clipping rather than painting over the next row.
 */
export const turnProcessRow = style({
  overflow: 'hidden',
  color: vars.fgMuted,
});

/**
 * 折叠头所在的那一行(tool-run 那一句也用它)。
 *
 * ⚠️ `nowrap` + `overflow: hidden` 不是排版偏好，是**高度契约的一部分**：这一行的
 * `measure()` 返回的是「一行正文」的常量高度，与视口宽度无关。任何东西一旦允许换行，
 * 窄视口下实际高度就会超出预留高度 —— 引擎的调试层会把这一行标红，而生产里表现为下面
 * 所有行的定位整体偏移（虚拟滚动按预留高度累加坐标）。⇒ 宁可裁掉，也不让这一行的高度
 * 变成宽度的函数。
 */
export const turnProcessLine = style({
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  minWidth: 0,
  flexWrap: 'nowrap',
  overflow: 'hidden',
});

/**
 * 折叠头本身不参与压缩。
 * 等宽数字:头每秒改一次「已处理 8m07s」,比例数字(1 比 0 窄)会让整句的宽度跟着变、后面的箭头每秒左右跳(owner 2026-10-22 真机录屏量到 ±2px)。
 */
export const turnProcessHeaderSlot = style({
  flex: '0 0 auto',
  minWidth: 0,
  fontVariantNumeric: 'tabular-nums',
});
