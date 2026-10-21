import { style } from '@vanilla-extract/css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────
// Every value that positions plan content. `lineH` is the body line-height the
// engine measured with, so the status-glyph column and the first text line of
// an entry are the same height by construction instead of by coincidence.

export type PlanStyleVars = {
  height: number;
  padY: number;
  iconBox: number;
  iconGap: number;
  entryGap: number;
  lineH: number;
  /** 进度条厚度（px）。 */
  barH: number;
  /** 表头与进度条之间的间距（px）。 */
  barGap: number;
};

export const planVars = createVariableThemeContract<PlanStyleVars>({
  height: null,
  padY: null,
  iconBox: null,
  iconGap: null,
  entryGap: null,
  lineH: null,
  barH: null,
  barGap: null,
});

// ── Row root ──────────────────────────────────────────────────────────────────
//
// @@@no card — the plan used to sit in a bordered, rounded shell whose header
// carried a second border underneath it (2 bordered elements, 5 edges, nesting
// depth 2). A header line plus an indented checklist already reads as one
// group, so the shell is gone and the row now matches the borderless
// header+body idiom that thinking and file-op already use.
//
// overflow: hidden mirrors thinkingRoot: any transient measure-vs-render height
// desync degrades to clipped content rather than spilling onto the next row.
export const planRoot = style({ height: planVars.height, overflow: 'hidden' });

// ── Progress bar（#4981 C7，照 elements-agent-plan）────────────────────────────
//
// 上游那个元素的视觉主体是「表头 + 一条 3px 进度条 + 清单」。表头我们本来就有（做成了
// 可折叠头），清单也有，唯独缺这条进度条 —— 而它是整行里**唯一一眼就能读出进度**的东西：
// 文字要读「3 / 7」，条子只要瞥一下长度。
//
// ⚠️ 高度进 `measure()`（`PlanVars.barH` + `barGap`），不是靠 margin 撑出来的：
// 这一行的高度是引擎的虚拟滚动坐标的一部分，任何不进 measure 的高度都会让它下面
// 所有行错位。

/**
 * ⚠️ 表头与条子之间的间距做成**自己的 padding**，不是 `margin-top`。
 *
 * `card-rows.contract` 量的是「行根的子元素 offsetHeight 之和 === 引擎预留高度」，
 * 而 margin **不计入 offsetHeight** —— 第一版用 margin，那条判据当场红：
 * 「stack to 87px inside a 89px row，leaving 2px the engine reserved and nothing occupies」。
 * 这正是它该抓的：预留了却没人占的高度，就是行与行之间的错位来源。
 * ⇒ 间距归到 track 身上（`border-box` + `padding-top`），背景只画到 content 区，
 *   于是 offsetHeight 恰好是 measure() 里加的那份，条子看上去仍是 barH 那么细。
 */
export const planProgressTrack = style({
  boxSizing: 'border-box',
  height: `calc(${planVars.barH} + ${planVars.barGap})`,
  paddingTop: planVars.barGap,
  borderRadius: planVars.barH,
  overflow: 'hidden',
  // 轨道用当前前景色压到很淡，跟着主题走，不自带一个写死的灰。
  background: 'color-mix(in srgb, currentColor 10%, transparent)',
  backgroundClip: 'content-box',
});

export const planProgressFill = style({
  display: 'block',
  height: planVars.barH,
  borderRadius: 'inherit',
  background: 'color-mix(in srgb, currentColor 55%, transparent)',
  // 宽度变化才过渡；`@media (prefers-reduced-motion)` 下整条关掉。
  transition: 'width 500ms ease',
  '@media': {
    '(prefers-reduced-motion: reduce)': {
      transition: 'none',
    },
  },
});
