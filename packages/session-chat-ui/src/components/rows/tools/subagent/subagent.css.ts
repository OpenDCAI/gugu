import { style } from '@vanilla-extract/css';
import { collapsibleRow } from '@session-chat/components/primitives/collapse-header.css';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

/**
 * 子调用相对头部的缩进量(px)。头部本身已不再有指示器格子(owner 2026-09-06:落定后那块
 * 空白),这两个数只剩 tool-group 给子调用算缩进在用。
 */
export const SUBAGENT_INDICATOR_W = 16;
/** Horizontal gap (px) between the indicator and the name. */
export const SUBAGENT_HEADER_GAP = 6;

export type SubagentStyleVars = {
  height: number;
};

export const subagentVars = createVariableThemeContract<SubagentStyleVars>({
  height: null,
});

export const subagentRoot = style({
  height: subagentVars.height,
  overflow: 'hidden',
  color: vars.fgPassive,
  userSelect: 'none',
});

// @@@no second line — the phase ("Running", "Completed") used to occupy its own
// 24px row under a 22px hanging indent, so one running subagent cost 46px and
// read as two unrelated lines with a word floating alone. The phase is a state
// of the name, not a second fact; every other row in the transcript states its
// status inline. Header height is now the shared `lineHeight + HEADER_ROW_EXTRA_H`
// that thinking / file-op / tool-group already use, so subagent no longer owns a
// bespoke height formula.
export const subagentHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: `${SUBAGENT_HEADER_GAP}px`,
  minWidth: 0,
});

// The one shared "this row answers the pointer" class, not a third copy of it.
export const subagentHeaderCollapsible = collapsibleRow;

export const subagentName = style({
  fontSize: vars.typeBodyFontSize,
  color: vars.fgMuted,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  minWidth: 0,
});

// Children of a subagent group align under its name rather than under its
// indicator, so the indent is derived from the gutter it has to clear instead
// of being a standalone 22.
export const subagentChildrenOffset = style({
  marginLeft: `${SUBAGENT_INDICATOR_W + SUBAGENT_HEADER_GAP}px`,
});
