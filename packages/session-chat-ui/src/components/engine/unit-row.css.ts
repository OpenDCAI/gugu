import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

/** Debug overlay: dashed outline around the reserved height slot. */
export const debugOverlay = style({
  pointerEvents: 'none',
  position: 'absolute',
  left: 0,
  right: 0,
  top: 0,
  outlineStyle: 'dashed',
  outlineWidth: '1px',
});

/** Debug overlay in OK state — faint green outline. */
export const debugOk = style({
  outlineColor: vars.diffAdded,
});

/** Debug overlay in mismatch state — red outline. */
export const debugMismatch = style({
  outlineColor: vars.diffDeleted,
});

/** Debug label chip — dark background, small monospace text. */
export const debugLabel = style({
  position: 'absolute',
  top: 0,
  left: 0,
  // 反相小标签:前景当底、底色当字,两套主题都读得出;❌ 写死黑底白字。
  background: vars.fg,
  paddingLeft: '4px',
  paddingRight: '4px',
  fontSize: '9px',
  lineHeight: 'tight',
  color: vars.bg,
});

/** Debug mismatch text — red. */
export const debugMismatchText = style({
  color: vars.diffDeleted,
});
