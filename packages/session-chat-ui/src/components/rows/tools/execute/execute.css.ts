import { globalStyle, style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';
import { EXECUTE_SCROLLBAR_GUTTER_X } from './execute.layout';
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type ExecuteStyleVars = {
  height: number;
};

export const executeCardVars = createVariableThemeContract<ExecuteStyleVars>({
  height: null,
});

// ── Row root ──────────────────────────────────────────────────────────────────
//
// @@@no card — execute used to sit in a bordered, rounded shell (CollapsibleCard)
// whose header carried a second border underneath it. The #3345 before baseline
// read it at 2 bordered elements / 5 border edges / nesting depth 2 / one 10px
// radius, in all four theme x width configurations — the last tool row still
// drawing a box around itself after thinking, plan, file-op and tool-group
// stopped. A header line above a monospace body already reads as one group, so
// the shell is gone and execute joins the borderless header+body idiom.
//
// Removing it also settles a 1px error the shell had been carrying: chromeY
// reserved three border widths, but `box-sizing: border-box` (styles/reset) puts
// the header separator inside the header's own 32px, so only two of the three
// were ever spent. Measured before the redraw: root clientHeight 73 against a
// 72px child sum.
//
// overflow: hidden mirrors thinkingRoot / planRoot: any transient
// measure-vs-render height desync degrades to clipped content rather than
// spilling onto the following row.
export const executeRoot = style({ height: executeCardVars.height, overflow: 'hidden' });

// ── Exit status ───────────────────────────────────────────────────────────────

/**
 * How the command ended, rendered inside the header's existing label line.
 *
 * @@@no new measurement input. It rides in the header's `children` slot rather
 * than in a slot of its own, so the row is still one `rowH`-tall header over the
 * same body: no extra line, no height change, nothing for the off-screen
 * measurer to learn. That is the whole reason this reading can be added without
 * touching `measure()` or the collapse path.
 *
 * Non-zero and signal-terminated exits take `fgError` — the same token the error
 * mark and the tool row's failure section carry — so "this went wrong" is one
 * colour across the transcript rather than a second red minted here. A zero exit
 * takes `fgPassive`, quieter than the label it follows: it is the confirmation
 * that the command finished and finished cleanly, not something to look at.
 */
export const executeExitStatus = style({
  marginLeft: '6px',
  flexShrink: 0,
  fontSize: vars.typeCodeFontSize,
  fontFamily: vars.typeCodeFontFamily,
  color: vars.fgPassive,
});

export const executeExitStatusFailed = style({ color: vars.fgError });

// ── Body ──────────────────────────────────────────────────────────────────────

/**
 * Wrapper: height + overflow set inline (depend on expanded state + bodyH).
 *
 * @@@fixed gutter — the command wrap width is computed off-screen (execute.layout),
 * so the width the browser will actually give a line has to be knowable without a
 * DOM. A vertical scrollbar is the one thing that can steal it, and its width is a
 * platform decision: 0 under macOS overlay scrollbars, ~15px under the classic
 * scrollbars used on Linux/Windows and in headless Chromium. `scrollbar-gutter:
 * stable` alone does not close that — it reserves the *platform's* width, which the
 * off-screen measurer still cannot name. Pinning the scrollbar to a known width and
 * reserving it in both states makes the reservation the same 8px everywhere, which
 * is what lets EXECUTE_SCROLLBAR_GUTTER_X appear in the measure math at all.
 */
export const executeBody = style({
  position: 'relative',
  scrollbarGutter: 'stable',
});

globalStyle(`${executeBody}::-webkit-scrollbar`, {
  width: `${EXECUTE_SCROLLBAR_GUTTER_X}px`,
  height: `${EXECUTE_SCROLLBAR_GUTTER_X}px`,
});

// ── Line ──────────────────────────────────────────────────────────────────────

// @@@engine owns the wrap, CSS renders it in the mode it was measured in.
//
// Where the line breaks is decided off-screen (execute.layout walks pretext and
// injects the measured break points as real newlines), the same way prose positions
// its shaped fragments. `overflow-wrap`/`word-break: normal` keep the browser from
// adding breaks of its own on top of those.
//
// The mode must be `pre-wrap`, not `pre`, and that is a measured fact rather than a
// preference: layout measures with `{ whiteSpace: 'pre-wrap' }`, where a space sitting
// at a break *hangs* and costs the line no width. Rendering the same text under `pre`
// turns that space back into a real glyph — one mono advance, 8px at 13px/mono — so
// every line whose break landed after a space came out 8px wider than it was measured
// to be. Read in the real session page at 1440px: command scrollWidth 640 against
// clientWidth 632, while the 780px window (whose breaks fell elsewhere) sat exactly at
// 418/418. Measuring one mode and painting another is the whole of that 8px.
export const executeLine = style({
  boxSizing: 'border-box',
  minWidth: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal',
  wordBreak: 'normal',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  color: vars.fg,
  // @@@no second inset — the 12px that used to sit here was clearing the card
  // border, not expressing a relationship. The row is already inset from the
  // transcript edge by the engine (ROW_INSET_X), and the `$` marker plus the
  // monospace face separate command from header, so the body now shares the
  // header's left edge the way thinking's and file-op's bodies do.
  //
  // line-height is set via inline style from theme.fonts.code.lineHeight
  // so it cannot drift from the measured value via a CSS variable.
});

// Output keeps single-line `pre` + horizontal scroll: wrapping it would break the
// column alignment that `ls`, `git status` and friends rely on to stay readable.
export const executeOutputLine = style({
  color: vars.fgMuted,
  whiteSpace: 'pre',
  overflowWrap: 'normal',
});

export const executeSpacerLine = style({
  userSelect: 'none',
});

globalStyle(`${executeLine} span`, {
  color: 'var(--shiki-light)',
});

globalStyle(`.emdark ${executeLine} span`, {
  color: 'var(--shiki-dark)',
});

// ── Command chip ──────────────────────────────────────────────────────────────

/**
 * 表头上那颗命令片(#4981)。
 *
 * 同一颗 `summaryChip`,和 `搜索 req.session` 戴的是一个 —— 那正是这一轮要的:
 * 一条 shell 命令和一次搜索查询在读者眼里应该是同一类东西(「工具带了个参数」),
 * 而不是「工具」与「一整块代码」两种分量。
 *
 * ❌ 别在这里加 `flex-shrink: 0` 之类:片必须能被挤扁并省略号收尾,否则一条一百字符的
 * 命令会把退出状态顶出固定高度的表头之外(表头 clip,顶出去就再也看不见)。
 */
export const executeCommandChip = style([summaryChip]);

// 表头左边那个标签曾经在这里有一个自己的类,写的是 `word-break: keep-all`(#4981)。
// 它只挡住了中文被拆成「执 / 行」,英文照旧在空格处折行 —— 640px 下命令片一占宽,标签
// 就撑成两行 34px、顶出 32px 的裁切线(card-rows 契约判红 2026-09-05)。
// ⇒ 一行到底与省略号收尾改由共享表头的 `collapseHeaderLabel` 统一管,这里不再另立一份。
