import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/**
 * The one-line chip a row wears beside its name — the search query, the fetched
 * URL, the shell command, the gist of a thought.
 *
 * Its whole job is to make an argument **scannable without being loud**: mono so
 * a path or a flag reads as a literal, a faint tint so it reads as a quotation
 * rather than as the agent's own prose, and one line with an ellipsis so a
 * hundred-character command cannot take the row over. The full text always
 * remains one click away in the row's payload — the chip is a preview, never the
 * only copy.
 *
 * Lives in `primitives/` rather than under `rows/tools/` because six row
 * families across three folders wear it and they must not drift: the whole point
 * of #4981 is that a shell command, a search query and a thought's first line
 * look like the same kind of thing. Anything that needs to differ belongs in the
 * consumer's own class, composed after this one.
 *
 * ⚠️ `lineHeight: 1` is load-bearing for the height contract. Both consumers sit
 * inside a fixed-height header (`ROW_H`) that clips; a chip that grew with the
 * body line-height would push the row past what `measure()` reserved. Keep the
 * chip's own box the sum of `fontSize x 1` plus `paddingBlock`, and keep that
 * under ROW_H.
 */
/**
 * 挤不下时**先**让位的那一格:片、思考要旨、文件头里的路径(#4981)。标签只在它让到 0 之后才收。
 *
 * ❌ 别用「把 flexShrink 调大」来表达「先让」:flex 的收缩按「基准宽 x 系数」**按比例**分摊,
 * 系数再大标签也要摊一份。这一份小到 0.09px(chromium 实测:760px 行、长命令、系数 100),
 * 而 `nowrap` + `ellipsis` 的标签只要少 0.01px 就画省略号 —— 「执行」照样成了「执…」
 * (owner 真机 2026-10-16,系数 100 / 1000 两处都中)。`scrollWidth` 是整数,读不出这一份,
 * 旧判据带 +1 容差,于是一直绿。
 *
 * ⇒ 基准宽给 0:它不参与收缩,只在标签与其余各格摆完之后**长**进剩下的地方,长到自己的
 * 自然宽为止(`max-content`,短命令照旧贴着文字宽)。剩下的地方不够,它就停在 0;
 * 标签自己还放不下时,标签照常收缩、省略号收尾 —— 长标签顶出退出状态那个老毛病不会回来,
 * 标签的 flexShrink 仍是 1。
 */
export const givesWayFirst = {
  flex: '1 1 0',
  minWidth: 0,
  maxWidth: 'max-content',
} as const;

export const summaryChip = style({
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  ...givesWayFirst,
  fontFamily: vars.typeCodeFontFamily,
  fontSize: vars.typeCodeFontSize,
  lineHeight: 1,
  paddingInline: 6,
  paddingBlock: 3,
  borderRadius: vars.radiusSm,
  background: 'color-mix(in srgb, currentColor 8%, transparent)',
  opacity: 0.85,
});
