import { style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import { givesWayFirst } from '@session-chat/components/primitives/summary-chip.css';
import { sx } from '@session-chat/styles/sprinkles.css';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract ─────────────────────────────────────────────────

/**
 * Contract for the file-op card vars. `height` is set on the root by the def;
 * `padY` is set locally by FileOpList / FileOpPreviewBody where it is consumed
 * via `padding-block`.
 */
export type FileOpStyleVars = {
  height: number;
  padY: number;
};

export const fileOpCardVars = createVariableThemeContract<FileOpStyleVars>({
  height: null,
  padY: null,
});

// @@@no resting container — file-op already had no border, background, radius or
// shadow: the #3345 before baseline read 0/0/0 for bordered elements, border
// edges and nesting depth in all four theme x width configurations. The redraw
// here is not about chrome; it is about the row honouring the height it is given
// and the type scale it is measured with.
//
// overflow: hidden brings this root in line with thinkingRoot / planRoot /
// subagentRoot: any transient measure-vs-render desync degrades to clipped
// content instead of drawing over the following row. It is a bound on the
// failure, not a fix for one — the fix is the single-line file name below, and
// what notices a regression is the inner-geometry contract, since a clipped
// overflow and a clean row have the same offsetHeight.
export const fileOpRoot = style({ height: fileOpCardVars.height, overflow: 'hidden' });

// A file row is one line: the verb, the file name, and an optional status icon
// pushed to the far edge. `fontSize` reads the measured body size rather than a
// rem step — the engine lays this row out from `theme.fonts.body`, and
// `0.875rem` only resolves to the same 14px while the host root stays at 16px.
export const fileRow = recipe({
  base: [
    sx({
      display: 'flex',
      alignItems: 'center',
      gap: '1.5',
      color: 'fgPassive',
    }),
    { fontSize: vars.typeBodyFontSize },
  ],
  variants: {
    clickable: {
      true: {
        cursor: 'pointer',
        selectors: {
          '&:hover': { color: vars.fgMuted },
        },
      },
      false: {},
    },
  },
});

/** The verb ("Read", "Edited") is two words at most and never gives up room. */
export const fileOpVerb = style({ flexShrink: 0 });

/**
 * The path is the truncatable cell. Without this it wrapped: a long name in
 * a narrow row laid out 93px of content inside the 32px the engine reserved, and
 * `measure() === offsetHeight` read 32 === 32 throughout.
 *
 * It is a flex line of its own so the directory and the file name can be given
 * different weights and, more importantly, different shrink priorities. No gap:
 * the pieces spell one continuous path.
 */
export const fileOpPath = style({
  display: 'flex',
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
});

/**
 * The path keeps its open-file action independently of the disclosure header.
 * In that header it sits beside the verb label and must give way first, or the
 * verb loses a sub-pixel share and ellipsizes to 「读…」 (see `givesWayFirst`).
 */
export const fileOpOpenPath = style([fileOpPath, givesWayFirst, {
  border: 0,
  padding: 0,
  background: 'none',
  font: 'inherit',
  cursor: 'pointer',
}]);

const pathCell = style({
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

// Both halves pin their own colour, so the row's `:hover { color }` no longer
// reaches them by inheritance — a clickable row would lose its only affordance.
// They restate it from the child side instead, which is the direction
// vanilla-extract allows: a rule may only target `&`, never a descendant.
const rowHover = `${fileRow.classNames.variants.clickable.true}:hover &`;

/**
 * The directory gives up room first: the file name only starts truncating once
 * the directory has nothing left to give. That ordering is the whole point — the
 * name is the token the reader came for, and a row that spends its last pixels
 * on `packages/task-…` while cutting the name has kept the half that every
 * sibling row already repeats.
 *
 * ❌ A shrink weight (this was 100-against-1) only makes the name's share small,
 * never zero — and any share at all ellipsizes it (「…image.p…」, 2026-10-16).
 * `givesWayFirst` takes the directory out of shrinking instead.
 */
export const fileOpPathDir = style([
  pathCell,
  givesWayFirst,
  { color: vars.fgPassive, selectors: { [rowHover]: { color: vars.fgMuted } } },
]);

/** The file name carries the contrast; the directory sits behind it. */
export const fileOpPathName = style([
  pathCell,
  { flexShrink: 1, color: vars.fgMuted, selectors: { [rowHover]: { color: vars.fgBody } } },
]);

/** Placeholder shown until the path-bearing update arrives. */
export const monoRunning = style({
  fontFamily: vars.typeCodeFontFamily,
  fontSize: vars.typeBodyFontSize,
  color: vars.fgPassive,
});

export const fileOpStatusIcon = style({
  marginLeft: 'auto',
  display: 'inline-flex',
  flexShrink: 0,
});

export const fileOpPermissionIcon = style([
  fileOpStatusIcon,
  {
    color: vars.fgPermission,
  },
]);

export const fileOpErrorIcon = style([
  fileOpStatusIcon,
  {
    color: vars.fgError,
  },
]);
