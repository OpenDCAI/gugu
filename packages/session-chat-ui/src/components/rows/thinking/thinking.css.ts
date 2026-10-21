import { style } from '@vanilla-extract/css';
import { givesWayFirst } from '@session-chat/components/primitives/summary-chip.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type ThinkingStyleVars = {
  height: number;
};

export const thinkingCardVars = createVariableThemeContract<ThinkingStyleVars>({
  height: null,
});

// overflow: hidden ensures that any transient measure-vs-render height desync
// (e.g. during a mid-tween frame or a stale virtualizer size) degrades to
// clipped content rather than spilling over the following row.
export const thinkingRoot = style({ height: thinkingCardVars.height, overflow: 'hidden' });

/**
 * 这一段思考的要旨（#4981 #7）。
 *
 * ❌ **不**戴 tool / execute 那颗 `summaryChip`：那颗片是给**字面量**用的（路径、命令、
 * 查询），等宽加淡底正是为了让它读起来像一段引文而不是 agent 自己的话 —— 那是它自己
 * 文档里写的理由。而一段思考的第一句**就是** agent 自己的话，装进引文片里等于说反了。
 *
 * 这也正是 #3334 的装饰盘点判据（`message-rows.contract`「thinking draws no container
 * of its own」）守着的东西：思考行是安静的散文，不画任何容器。第一版在这里挂了带底色的
 * 片，那条判据当场判红 —— 它是对的（2026-09-05）。
 *
 * ⇒ 素文本、淡一档、一行到底、挤不下省略号收尾。
 */
export const thinkingSummaryText = style({
  // 挤不下时先让要旨收,标签(「思考了 3s」)最后才收(2026-10-02 手机「Th…」)。
  // 怎么做到「先」见 `givesWayFirst` —— ❌ 调大 flexShrink,那只能让标签少收、收不到 0。
  ...givesWayFirst,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  opacity: 0.7,
});
