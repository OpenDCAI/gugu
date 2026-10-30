import { style } from '@vanilla-extract/css';
import { givesWayFirst } from '@session-chat/components/primitives/summary-chip.css';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

export type ResourceLinkStyleVars = { rowH: number };

export const resourceLinkVars = createVariableThemeContract<ResourceLinkStyleVars>({ rowH: null });

export const resourceLinkRoot = style({
  height: resourceLinkVars.rowH,
  display: 'flex',
  alignItems: 'stretch',
});

// ── Row surface ───────────────────────────────────────────────────────────────
//
// @@@no resting container — a single line of text does not need a card.
// The clickable variant used to carry a 1px border, an 8px inset and a radius,
// which made the same content sit at two different x-offsets depending only on
// whether the target happened to be openable. Both variants now share one
// borderless, inset-free shape: the icon and the title/path type contrast do
// the grouping, and clickability is expressed by the hover rules below.
const rowBase = style({
  display: 'flex',
  alignItems: 'center',
  columnGap: '8px', rowGap: '4px', flexWrap: 'wrap',
  minWidth: 0,
  maxWidth: '100%',
  fontSize: vars.typeBodyFontSize,
  height: '100%',
});

export const rowStatic = rowBase;

// @@@hover is Lane B only — colour and text-decoration paint without touching
// the box model, so a pointer entering this row can never move measured
// geometry or the content below it.
export const rowClickable = style([rowBase, { cursor: 'pointer' }]);

// ── Cells ─────────────────────────────────────────────────────────────────────

export const iconWrap = style({ color: vars.fgMuted, flexShrink: 0, display: 'flex' });

export const titleText = style({
  color: vars.fgBody,
  // Both text cells shrink so a long name or a long path ellipsizes instead of
  // spilling past the row inset; `keeps an over-long name and path inside the
  // row width` in the contract suite is the sentinel for this. The path gives
  // way first (`givesWayFirst`): the name is what the reader came for, and two
  // cells shrinking in proportion would clip the name while the path still had
  // room (#7316).
  flex: '0 1 auto',
  minWidth: 0,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal',
  transition: 'color 150ms',
  selectors: {
    [`${rowClickable}:hover &`]: {
      color: vars.link,
      textDecoration: 'underline',
      textUnderlineOffset: '2px',
    },
  },
});

export const pathText = style({
  color: vars.fgMuted,
  ...givesWayFirst,
  whiteSpace: 'pre-wrap',
  overflowWrap: 'normal',
  fontSize: '0.75rem',
});

export const sizeText = style({
  color: vars.fgMuted,
  flexShrink: 0,
  fontSize: '0.75rem',
  fontWeight: 400,
});
