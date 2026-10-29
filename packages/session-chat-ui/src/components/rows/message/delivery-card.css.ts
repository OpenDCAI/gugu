import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

// ── Runtime geometry contract (set per instance by DeliveryCard) ──────────────

export type DeliveryStyleVars = {
  height: number;
  padY: number;
  headerH: number;
  lineH: number;
  factsH: number;
  gap: number;
  /** Avatar diameter in the source line. */
  avatar: number;
  /** Same available column as the ordinary user message. */
  width: number;
};

export const deliveryVars = createVariableThemeContract<DeliveryStyleVars>({
  height: null,
  padY: null,
  headerH: null,
  lineH: null,
  factsH: null,
  gap: null,
  avatar: null,
  width: null,
});

/** Delivered inputs share the user bubble; only the small source line is additional. */
export const deliveryRoot = style({
  position: 'relative',
  boxSizing: 'border-box',
  height: deliveryVars.height,
  overflow: 'hidden',
  color: vars.fgBody,
  paddingTop: deliveryVars.padY,
  paddingBottom: deliveryVars.padY,
});

export const deliveryHeader = style({
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  height: deliveryVars.headerH,
  minWidth: 0,
  width: deliveryVars.width,
  marginLeft: 'auto',
  justifyContent: 'flex-end',
  color: vars.fgMuted,
  fontSize: vars.typeChromeTinyFontSize,
  lineHeight: deliveryVars.lineH,
});

/**
 * The sender's avatar slot (#6306): a fixed-width round frame. It holds the sender's real image
 * (uploaded picture or the host's generated face) or stays empty (no identity / not known yet) —
 * no fill, no drawn stand-in, so an empty slot never reads as a hollow status ring. The width is
 * constant in every state, so the image landing later moves nothing.
 */
export const deliveryAvatar = style({
  display: 'inline-flex',
  width: deliveryVars.avatar,
  height: deliveryVars.avatar,
  flexShrink: 0,
  borderRadius: vars.radiusFull,
  overflow: 'hidden',
});

/** The sender's image (#6306): uploaded picture or the host's generated face — never a drawn stand-in. */
export const deliveryAvatarImage = style({
  width: '100%',
  height: '100%',
  objectFit: 'cover',
  userSelect: 'none',
});

export const deliverySender = style({
  color: vars.fgMuted,
  fontWeight: 400,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  // The sender is the one fact the header exists for: it may ellipsize but
  // never vanish — it does not shrink, it is capped instead; the route gives
  // way. ❌ a `min-width: 8ch` floor: a short name (「Claude 2」) is narrower
  // than 8ch and the floor shows up as a blank gap before the route.
  flexShrink: 0,
  maxWidth: '60%',
});

export const deliveryRoute = style({
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  flexShrink: 3,
  color: vars.fgMuted,
});

/**
 * 「详情」— quiet at rest (passive ink), full ink on hover / focus / while
 * open. Always painted: an affordance that only appears on hover does not
 * exist on a touch screen.
 */
export const deliveryFactsToggle = style({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '8px',
  minWidth: 0,
  maxWidth: '100%',
  border: 'none',
  background: 'transparent',
  padding: 0,
  color: vars.fgPassive,
  cursor: 'pointer',
  font: 'inherit',
  whiteSpace: 'nowrap',
  flexShrink: 0,
  selectors: {
    '&:hover, &:focus-visible, &[aria-expanded="true"]': { color: vars.fg },
    '&:not(button)': { cursor: 'default' },
  },
});

export const deliveryReply = style({
  display: 'block',
  background: 'transparent',
  border: 0,
  padding: 0,
  textAlign: 'left',
  fontFamily: 'inherit',
  cursor: 'pointer',
  selectors: { '&:hover:not(:disabled)': { color: vars.fg }, '&:focus-visible': { outline: `1px solid ${vars.fgMuted}`, outlineOffset: 2 }, '&:disabled': { cursor: 'default' } },
  height: deliveryVars.lineH,
  lineHeight: deliveryVars.lineH,
  marginTop: deliveryVars.gap,
  marginLeft: 'auto',
  width: deliveryVars.width,
  boxSizing: 'border-box',
  color: vars.fgMuted,
  fontSize: vars.typeChromeTinyFontSize,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  borderLeft: `2px solid ${vars.border}`,
  paddingLeft: '8px',
});

/**
 * Structured facts (the details tier): one nowrap row per fact, label beside
 * value, so the band's height is rows × line-height — a sum of constants, no
 * typesetting. Long values ellipsize and carry the full text in `title`.
 */
export const deliveryFacts = style({
  display: 'grid',
  gridTemplateColumns: 'max-content minmax(0, 1fr)',
  columnGap: '12px',
  alignContent: 'start',
  height: deliveryVars.factsH,
  boxSizing: 'border-box',
  marginTop: deliveryVars.gap,
  marginLeft: 'auto',
  width: deliveryVars.width,
  padding: '6px 8px',
  overflow: 'hidden',
  borderRadius: vars.radiusSm,
  background: vars.bg2,
  fontSize: vars.typeMentionFontSize,
  lineHeight: deliveryVars.lineH,
});

export const deliveryFactLabel = style({
  color: vars.fgPassive,
  whiteSpace: 'nowrap',
});

export const deliveryFactValue = style({
  color: vars.fgMuted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
});
