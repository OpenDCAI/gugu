import { globalStyle, style } from '@vanilla-extract/css';
import { collapsibleRow } from '@session-chat/components/primitives/collapse-header.css';
import { MEASURED_SCROLLBAR_GUTTER_X } from '@session-chat/core/measure/soft-wrap';
import { sx } from '@session-chat/styles/sprinkles.css';
import { vars } from '@session-chat/styles/theme.css';
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';
import { TOOL_THUMB_GAP, TOOL_THUMB_H, TOOL_THUMB_PAD_TOP, TOOL_THUMB_W } from './tool-images';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type ToolStyleVars = { rowH: number; height: number };

export const toolVars = createVariableThemeContract<ToolStyleVars>({ rowH: null, height: null });

// @@@no border — `border-color` was declared here with no border-width, so it
// painted nothing: the #3345 before baseline reads this row at 0 bordered
// elements / 0 border edges in all four theme×width configurations. A colour
// with no edge is a declaration that looks load-bearing and is not; the next
// reader adds `border-width` to "restore" a border that never existed.
// The root now spans header + payload panel, so its height is the unit height
// rather than the header's. Rows with no payload measure to `rowH` and the two
// are the same number, which is why the header keeps its own explicit height:
// it must stay `rowH` tall whatever the panel below it does.
export const toolRoot = style([
  sx({ display: 'flex', flexDirection: 'column' }),
  // overflow:hidden ensures content never escapes the reserved height.
  { height: toolVars.height, overflow: 'hidden' },
]);

export const toolRow = style([
  sx({ display: 'flex', alignItems: 'center', gap: '1.5', color: 'fgPassive', userSelect: 'none' }),
  // min-width:0 lets flex children shrink below their intrinsic width so
  // text-overflow ellipsis can take effect on the name and summary spans.
  { minWidth: 0, height: toolVars.rowH, flexShrink: 0 },
]);

// Only rows that actually have a payload become a toggle; the plain rows keep
// the default cursor and no hover response, so the affordance never promises a
// panel that isn't there. This is the shared class CollapseHeader wears for the
// same reason, so a tool row and a thinking / execute header answer the pointer
// alike — and there is one class to change, not three copies of it.
export const toolRowCollapsible = collapsibleRow;

/**
 * Fixed box the shared chevron rotates inside.
 *
 * Two things the primitive does not do on its own, both measured rather than
 * assumed (the narrow-width containment reading in tool-rows.contract.test.tsx
 * is what found them):
 *
 *   • No shrink rule. This row's name and summary both carry `min-width: 0` so
 *     they can ellipsize; a flex line of nothing but shrinkable items takes the
 *     missing pixels out of the chevron too.
 *   • `rotate(90deg)` is painted about the glyph box's centre, and that box is
 *     ~3px wide against a ~13px line, so the expanded chevron paints about 5px
 *     wider than it lays out — on either side. CollapseHeader never notices
 *     because its chevron sits mid-row with text on both sides. Here it is the
 *     first item in the row, so the left half of that overhang lands outside the
 *     row entirely: read at 4.83px past a 180px row before this slot existed.
 *
 * Sizing the slot to the rotated footprint puts the overhang back inside the row.
 */
export const toolChevronSlot = style({
  flexShrink: 0,
  display: 'inline-flex',
  justifyContent: 'center',
  alignItems: 'center',
  width: '14px',
});

export const toolName = style({
  fontSize: vars.typeBodyFontSize,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  flexShrink: 1,
  minWidth: 0,
});

/**
 * 工具调用的「查询」——上游 `elements-tool-call` 把它画成一枚**等宽药丸片**
 * （`mono` + 极淡底 + 圆角），而不是一段跟工具名同款的正文（#4981 C8）。
 *
 * 这不只是好看：工具名是我们的词汇（「读取文件」），查询是**它作用的那个东西**
 * （一个路径、一个 glob、一句搜索词）——后者是数据不是文案，等宽 + 底色让这条边界
 * 在一行里一眼可分。同一套片子已经用在折叠头的文件统计上（#4981 C6），两处共用一套视觉。
 *
 * ⚠️ 不给垂直内边距、行高钉死 1：这一行的高度是常量 `ROW_H`，任何让行内盒子长高的东西
 * 都会被行根裁掉（`toolRoot` 有 overflow hidden），看起来就是「药丸被切了一刀」。
 */
// 片本身搬去了 `primitives/summary-chip.css`:execute / thinking 行也要戴同一颗(#4981),
// 两处各写一份迟早会分叉,而「shell 命令和搜索查询看上去是同一类东西」正是这一轮的目的。
export const toolSummary = style([summaryChip]);

export const toolStatusIcon = style({
  marginLeft: 'auto',
  display: 'inline-flex',
  flexShrink: 0,
});

export const toolPermissionIcon = style([
  toolStatusIcon,
  {
    color: vars.fgPermission,
  },
]);

export const toolErrorIcon = style([
  toolStatusIcon,
  {
    color: vars.fgError,
  },
]);

// 「做完了」那个绿勾已退休(#4981):这一格只留需要读者看一眼的记号。
// 理由写在 `Tool.tsx` 的渲染处 —— 上游 tool-call 与 tool-timeline 在这一格上说的不是
// 一件事,gugu 的工具行两个身份都当,只能取一个,取的是 timeline。

// ── Picture strip (tool-images.ts) ────────────────────────────────────────────

// Every number here is the one tool-images.ts measured with: the strip's height is set inline from the strip, the
// boxes are fixed, and the picture is contained in its box — so no picture, of any size, moves the row.
export const toolThumbs = style({
  display: 'flex',
  alignItems: 'flex-start',
  gap: `${TOOL_THUMB_GAP}px`,
  paddingTop: `${TOOL_THUMB_PAD_TOP}px`,
  boxSizing: 'border-box',
  flexShrink: 0,
  overflow: 'hidden',
});

export const toolThumb = style({
  position: 'relative',
  flex: '0 0 auto',
  width: `${TOOL_THUMB_W}px`,
  maxWidth: '100%',
  height: `${TOOL_THUMB_H}px`,
  padding: 0,
  border: 'none',
  borderRadius: vars.radiusMd,
  background: vars.bgHover,
  overflow: 'hidden',
  cursor: 'zoom-in',
});

globalStyle(`${toolThumb}:hover`, { background: vars.bgPress });

export const toolThumbImage = style({
  display: 'block',
  width: '100%',
  height: '100%',
  objectFit: 'contain',
});

/** 「还有几张」:一枚小片压在最后一个框的右下角,❌ 盖住整张图。 */
export const toolThumbMore = style({
  position: 'absolute',
  right: '4px',
  bottom: '4px',
  padding: '0 6px',
  borderRadius: vars.radiusFull,
  background: vars.bg,
  color: vars.fg,
  // 标记档 12/18(#7333)。
  fontSize: vars.typeChromeTinyFontSize,
  lineHeight: '18px',
});

// ── Payload panel ─────────────────────────────────────────────────────────────

/**
 * One section (request or result) of the expanded panel.
 *
 * Height and overflow come from inline style because both depend on the
 * measured geometry. @@@fixed gutter — the wrap width is computed off-screen
 * (tool.layout), so the width the browser will actually give a line has to be
 * knowable without a DOM; pinning the scrollbar to a known width is what makes
 * MEASURED_SCROLLBAR_GUTTER_X nameable in the measure math. Same reason, same
 * number as the execute body.
 */
// @@@flex-shrink:0 is load-bearing, not defensive. `toolRoot` is a fixed-height
// flex column, so a section left at the default `flex-shrink: 1` is silently
// resized to whatever is left over — a panel measured taller than the row
// reserved would be squashed back into place and every height reading, root and
// section alike, would still agree. That is a fail-quiet path: the payload comes
// out cut with nothing anywhere reporting it. Pinned at 0, the same disagreement
// overflows into the root's `overflow: hidden` where a reading can see it.
export const toolPayloadSection = style({
  position: 'relative',
  flexShrink: 0,
  scrollbarGutter: 'stable',
  overflowX: 'hidden',
});

globalStyle(`${toolPayloadSection}::-webkit-scrollbar`, {
  width: `${MEASURED_SCROLLBAR_GUTTER_X}px`,
  height: `${MEASURED_SCROLLBAR_GUTTER_X}px`,
});

// @@@engine owns the wrap, CSS renders it in the mode it was measured in.
// `pre-wrap` is not a preference: tool.layout measures with
// `{ whiteSpace: 'pre-wrap' }`, where a space at a break hangs and costs the
// line no width. Under `pre` that space becomes a real glyph again and every
// line whose break followed a space paints one mono advance wider than measured.
export const toolPayloadLine = style({
  boxSizing: 'border-box',
  minWidth: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal',
  wordBreak: 'normal',
  fontSize: vars.typeCodeFontSize,
  fontWeight: vars.typeCodeFontWeight,
  fontFamily: vars.typeCodeFontFamily,
  userSelect: 'text',
});

// Request reads as the quieter half — it restates what the header already
// summarizes — while the result is the answer the user opened the row for.
export const toolPayloadRequest = style({ color: vars.fgMuted });
export const toolPayloadResult = style({ color: vars.fg });

// The failure section carries the same token the error icon does, so the mark in
// the status slot and the text explaining it are one statement in one colour
// rather than two red-ish things that happen to co-occur. It is the only section
// that shows up uninvited, which is exactly why it is the one that gets to be
// the loudest thing in the row.
export const toolPayloadError = style({ color: vars.fgError });
