/**
 * boundary.css.ts —— 对话里的「界线」行共用的一套画法。
 *
 * 现在有两种界:上下文压缩（`compaction`）与引擎重开会话（`context-reset`）。它们说的是
 * 同一类事 —— **这条线以上的内容，agent 记得的不是原文** —— 所以用同一种视觉，
 * ❌ 别为第二种再发明一套；差别全部落在标签那句话上。
 *
 * 形态借日界行（`day-separator`）：两侧发丝线 + 中间一枚弱化标签。
 *
 * ⚠️ 与日界行同一条约束：所有尺寸都要留在各自的 `*_ROW_H` 里面。这些行的 `measure()`
 * 是常量，画高了不会让行长高，只会被静静裁掉。
 */

import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const boundaryRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '10px',
  // 与日界行同理：拖选一段对话不该把这条界一起复制走。
  userSelect: 'none',
});

export const boundaryRule = style({
  flex: '1 1 0',
  height: '1px',
  background: vars.border,
  minWidth: 0,
});

/**
 * ⚠️ 2026-09-22 按 design.md 统一:字体从 `fontMono` 退回 `fontSans`。
 * design.md 的 type register 是 settled law —— 「**Mono** has exactly one job:
 * **the thing you type or install** … **Mono is never prose and never emphasis.**」
 * 而这枚标签承载的是**整句话**(「上下文压缩失败」「引擎重开了这次会话 —— 上面的内容它一句都不记得」,
 * 见 `localization.tsx`),不是标识符。层级交给字号(标注档 12/18,#7333)与 `fgMuted`,不靠换一张字脸。
 * 真正该 mono 的是压缩掉的 token 数,它现在藏在 `title` 里。
 */
export const boundaryLabel = style({
  // 行窄到放不下这句话时(发丝线先缩到 0),标签收成省略号,❌ 顶出行的右沿 —— 行高是常量,不能折行。
  // #7333 标注档 12/18 下,固定文案在 420 宽就已经超出(压缩完成 415、引擎重开 427,11 号时还各差十几像素才满),
  // 所以每一种界线标签都要能缩。被截掉的那句话由各行的 title 补全(行的 aria-label 本来就是整句)。
  flex: '0 1 auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  fontFamily: vars.fontSans,
  fontSize: '12px',
  lineHeight: '18px',
  letterSpacing: '0.02em',
  color: vars.fgMuted,
  whiteSpace: 'nowrap',
});

/**
 * 标签长度不由我们定的那种(session-notice 的供应商原文)。可缩、省略号现在每一种标签都有(见 boundaryLabel),
 * 这枚 class 留作这种标签的标记;行高是常量(见抬头),❌ 折行 —— 全文在行的 `title` 里。
 */
export const boundaryLabelShrinkable = style({
  flexShrink: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

/**
 * 会话状态行里那段可点的强调文字（`session-condition`）。
 *
 * ⚠️ 它是**句子里的一段**，❌ 不是底下单独摆的一颗按钮 —— owner 对这种形态的原话是
 * 「你这样搞得很突兀」。所以它继承标签的字号与行高，只换颜色并加下划线。
 */
export const boundaryAction = style({
  // 不缩:窄的时候让标签先收成省略号,这段可点的字始终完整、留在行里。
  flex: '0 0 auto',
  // 它是标签那句话里的一段,字体必须跟着标签走(见 boundaryLabel 的抬头)。
  fontFamily: vars.fontSans,
  fontSize: '12px',
  lineHeight: '18px',
  letterSpacing: '0.02em',
  color: vars.link,
  whiteSpace: 'nowrap',
  cursor: 'pointer',
  textDecoration: 'underline',
  textUnderlineOffset: '2px',
  background: 'none',
  border: 'none',
  padding: 0,
});
