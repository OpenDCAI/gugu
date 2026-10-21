/**
 * day-separator.css.ts — 日界分隔行。
 *
 * ⚠️ 这里每一个尺寸都要留在 `DAY_SEPARATOR_ROW_H` 里面。这一行的 `measure()` 是常量，
 * 行根写死了同一个高度，所以"画高了"不会让行长高，只会被静静裁掉 —— 高度契约照样吻合，
 * 而用户看到的是一条被切掉一半的标签。⇒ 判它的不是行根高度，而是
 * `height.contract.test.tsx` 里从行内部读标签 rect 的那几条。
 *
 * 解剖取自上游 `elements-day-separator`：两侧各一条发丝线，中间一枚弱化的等宽标签。
 * ❌ 不照抄它的像素（上游裹在 `max-w-sm` 里，我们的行是整幅宽度），也不照抄它的
 * `bg-foreground/[0.08]` —— 本仓的边框色有自己的亮暗 token。
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const separatorRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  // 整行不参与文本选择：读者拖选一段对话时不该把日期一起复制走。
  userSelect: 'none',
});

/** 发丝线。1px 而不是 `borderTop`，这样两侧长度由 flex 均分，与标签宽度无关。 */
export const separatorRule = style({
  flex: '1 1 0',
  height: '1px',
  background: vars.border,
  // 三个 flex 子项里只有它可以被压缩到 0；标签永远完整。
  minWidth: 0,
});

/**
 * ⚠️ 2026-09-22 按 design.md 统一:字体从 `fontMono` 退回 `fontSans`。
 * 上游那枚标签是 `font-mono`,咕咕这里不照抄 —— design.md 的 type register 把 mono 限死在
 * 「**the thing you type or install**」,而这里写的是「今天」「9 月 20 日 星期六」这种**说辞**。
 * 日期里那几位数字不抖,靠的是下面的 `tabular-nums`(它对 sans 一样生效),不是整行换成等宽。
 */
export const separatorLabel = style({
  flex: '0 0 auto',
  fontFamily: vars.fontSans,
  // #7333 标注档 12/18,落在 24 的行里(height.contract 从行内部读标签矩形)。
  fontSize: '12px',
  lineHeight: '18px',
  letterSpacing: '0.02em',
  // 数字等宽：滚动经过多条分隔行时日期不会左右抖。
  fontVariantNumeric: 'tabular-nums',
  color: vars.fgMuted,
  whiteSpace: 'nowrap',
});
