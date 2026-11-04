import { createVar, globalStyle, style } from '@vanilla-extract/css';
import { recipe } from '@vanilla-extract/recipes';
import {
  ATTACH_LABEL_GAP,
  ATTACH_LABEL_LINE,
  ATTACH_TILE,
  ATTACH_TILE_GLYPH,
  USER_MESSAGE_ACTION_GAP,
  type MessageStyleVars,
} from './metrics';
import { vars } from '@session-chat/styles/theme.css';
import { createVariableThemeContract } from '@session-chat/styles/variable-theme-contract.css';

/**
 * Dedicated group-hover marker for the stop button.
 *
 * Apply this class to the user card root so that hovering anywhere on the card
 * reveals the stop button. Keying the reveal to this dedicated empty marker
 * (rather than a structural class like cardRoot) isolates it from the
 * messageGroup/codeGroup hover reveals already present in descendant nodes,
 * preventing cross-nesting leakage — same pattern as the copy-button isolation.
 */
export const userCardGroup = style({});

// ── Runtime geometry contract ─────────────────────────────────────────────────
// Set per-instance via assignInlineVars in message.def.tsx.

export const cardVars = createVariableThemeContract<MessageStyleVars & { height: number }>({
  height: null,
  userCardPadX: null,
  userCardPadY: null,
  cardBorder: null,
  attachThumb: null,
  attachGap: null,
  attachChipH: null,
  attachChipW: null,
});

// No class-level `overflow` here, deliberately — unlike every sibling row root
// that is handed an engine height. `UserMessageCard` writes `overflow-y` inline
// on every render (`hidden` while collapsed or animating, `auto` when expanded
// at rest, so long messages stay scrollable), and a non-visible `overflow-y`
// makes `overflow-x` compute to `auto` rather than stay `visible`. Both branches
// therefore contain a height surplus; measured, not assumed — see the
// "user card contains a transient surplus" contract, which also keeps the
// inline style from being dropped silently.
export const cardRoot = style({ height: cardVars.height });

// ── UserMessageCard ───────────────────────────────────────────────────────────

/**
 * @@@user-bubble-radius (Refs #6109) — 用户气泡 = `--radius-thread`(16px)。
 *
 * design.md 的 shape 表把这一档的语义写成「composer **and user bubble**, product surfaces only」。
 * 同一个部件在本仓原来有四个取值:单栏 8(这里)、双栏 14、手机端 stock Thread 12、
 * 手机端旧路径 12 —— 没有一个落在 16 上。单栏这一支 2026-09-22 归位。
 *
 * ⚠️ 描边**保留**,没有跟着 design.md 的「淡底胶囊」去掉:宿主把 chat-bg / chat-bg-2 /
 * chat-user-card-bg 三个面色都映射成同一个白(下面双栏那段注释记的实测),单栏气泡现在
 * **只靠这条边被看见**;而它同时是「这条消息可展开/可滚」那个 hover 反馈的载体
 * (`state=overflowing` 与 `current` 两个变体都是提亮边色)。去边要先给单栏也上一档
 * color-mix 底色并给 hover 另找载体 —— 那是观感改动,留给 owner 看一眼再动。
 */
/** 气泡自己的底色。折叠渐隐从它淡出 —— 宿主把气泡反色以后(底 = 前景色),从页面底色淡出会在末行上抹一道。 */
const cardSurface = createVar();

export const card = recipe({
  base: {
    vars: { [cardSurface]: vars.userCardBg },
    position: 'relative',
    borderRadius: vars.radiusThread,
    borderStyle: 'solid',
    borderWidth: cardVars.cardBorder,
    borderColor: vars.userCardBorder,
    background: cardSurface,
    color: vars.bubbleUserFg,
    paddingLeft: cardVars.userCardPadX,
    paddingRight: cardVars.userCardPadX,
    paddingTop: cardVars.userCardPadY,
    paddingBottom: cardVars.userCardPadY,
    boxSizing: 'border-box',
    selectors: {
      // `double`: borderless user bubble. Geometry is decided in
      // metrics.ts and arrives through cardVars; only paint lives here.
      '[data-chat-layout="double"] &': {
        // 圆角与单栏同一档(见 @@@user-bubble-radius);原来这里是 radiusXl(当时 14px)。
        borderColor: 'transparent',
        // Paired fill/text tokens let the host match the native reference
        // (owner 2026-10-17) while standalone themes retain their own palette.
        vars: { [cardSurface]: vars.bubbleUser },
      },
    },
  },
  variants: {
    state: {
      static: {},
      overflowing: {
        selectors: {
          '&:hover': { borderColor: vars.userCardBorderHover },
        },
      },
    },
    /** When true, the hover border shows regardless of overflow state. */
    current: {
      false: {},
      true: {
        selectors: {
          '&:hover': { borderColor: vars.userCardBorderHover },
        },
      },
    },
  },
});

/**
 * Stop button — absolutely positioned top-right of the user message card.
 *
 * Isolated reveal: opacity 0 by default; revealed only when `userCardGroup`
 * is hovered (`${userCardGroup}:hover &`). The reveal selector is on this
 * style itself (not a shared base), and keyed to the dedicated `userCardGroup`
 * marker, so it cannot leak to/from the messageGroup/codeGroup hover contexts
 * in descendant code blocks or sibling assistant messages.
 */
export const stopButtonOverlay = style({
  position: 'absolute',
  top: '6px',
  right: '6px',
  zIndex: 10,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '4px',
  borderRadius: vars.radiusSm,
  border: 'none',
  background: 'transparent',
  color: vars.fgMuted,
  cursor: 'pointer',
  opacity: 0,
  transition: 'opacity 150ms ease',
  selectors: {
    [`${userCardGroup}:hover &`]: { opacity: 1 },
    '&:focus-visible': { opacity: 1 },
    '&:hover': { color: vars.fg },
  },
});

/**
 * 附件条 —— 挂在气泡**外面、上方**(#5269)。owner 2026-09-10 给的参考是 Kimi:附件卡浮在
 * 气泡外,气泡只包文字,于是没有那一大片灰底。
 *
 * ⚠️ 高度由 `attachStripHeight` 算出来后写在行内 —— 这条与卡片是兄弟,行的总高是
 * 「条 + 卡片」,两边各自的数必须对得上(`measure() === offsetHeight`)。
 */
/** 附件条:同宽的卡片并排,排不下换行。 */
export const attachmentStrip = style({
  boxSizing: 'border-box',
  display: 'flex',
  flexWrap: 'wrap',
  gap: cardVars.attachGap,
  paddingBottom: cardVars.attachGap,
});

/** 一条用户消息的根:附件条、气泡、消息操作。 */
export const userMessageRoot = style({
  display: 'flex',
  flexDirection: 'column',
});

/** Message-level actions sit below the bubble and keep their space on hover. */
export const userMessageActions = style({
  display: 'flex',
  flexWrap: 'nowrap',
  minWidth: 0,
  justifyContent: 'flex-end',
  alignItems: 'center',
  gap: '4px',
  paddingTop: `${USER_MESSAGE_ACTION_GAP}px`,
  boxSizing: 'border-box',
  flexShrink: 0,
  opacity: 0,
  pointerEvents: 'none',
  transition: 'opacity 150ms ease',
  selectors: {
    [`${userMessageRoot}:hover &`]: { opacity: 1, pointerEvents: 'auto' },
    [`${userMessageRoot}:focus-within &`]: { opacity: 1, pointerEvents: 'auto' },
  },
  '@media': {
    '(hover: none)': { opacity: 1, pointerEvents: 'auto' },
    '(prefers-reduced-motion: reduce)': { transition: 'none' },
  },
});

export const userMessageActionButton = style({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  aspectRatio: '1',
  boxSizing: 'border-box',
  padding: '4px',
  border: 'none',
  borderRadius: vars.radiusSm,
  background: 'transparent',
  color: vars.fgMuted,
  cursor: 'pointer',
  selectors: {
    '&:hover': { color: vars.fg, background: vars.bgHover },
    '&:focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: '1px' },
  },
});

/** 对话布局里折着的长消息:时间那一行最前面的「展开全文」。 */
export const userMessageExpandRow = style({
  display: 'flex', justifyContent: 'flex-end', alignItems: 'flex-end',
});

export const userMessageExpand = style({
  padding: 0, border: 0, background: 'transparent', cursor: 'pointer',
  minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 1, lineHeight: '16px',
  color: vars.fgMuted, fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize, whiteSpace: 'nowrap',
  selectors: { '&:hover': { color: vars.fg }, '&:focus-visible': { outline: `1px solid ${vars.fgMuted}`, outlineOffset: 2, borderRadius: 3 } },
});

export const userMessageTime = style({
  flexShrink: 0,
  alignSelf: 'center', marginRight: 8, color: vars.fgMuted,
  fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize,
  whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums',
});

/**
 * 一枚附件卡 —— 一个有厚度的图块,名字在**图块之外的下方**(owner 2026-09-10 定的形状,
 * 推导见 `metrics.ts`)。卡片本身不画底、不画框:名字不占那个方框,方框才立得起来。
 */
export const attachChip = style({
  boxSizing: 'border-box',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: `${ATTACH_LABEL_GAP}px`,
  width: cardVars.attachChipW,
  height: cardVars.attachChipH,
  padding: 0,
  margin: 0,
  border: 'none',
  background: 'transparent',
  color: vars.fg,
  font: 'inherit',
  cursor: 'pointer',
});

/**
 * 图块。浅底 + 圆角。❌ 不加描边(owner 否过两次)。
 *
 * ⚠️ 2026-09-22 按 design.md 统一:投影删掉。原裁决:「投影是『别这么扁平』那句话要的那一格:
 * 它让方块看着是浮起来的一件东西,而不是一片色块。」
 * 被推翻的理由:「**Shadows are zeroed globally. Only a floating surface may lift.**」
 * 加上 Reject 列表的「**ornamental shadows**」。这枚图块住在转录里、**跟着内容滚**,
 * 它不是浮层,也不盖住任何东西 —— 那层柔光是纯装饰,理由本身就写着「别这么扁平」。
 *
 * 「别这么扁平」这件事没有丢:静止 `bgHover` → hover/focus `bgPress` 是同一条底色阶梯
 * (它本来就在,下面两条 globalStyle 里),深浅一变就读得出「这块是可点的一件东西」。
 * ⇒ 层级换了表达方式,不是被删掉了。
 */
export const attachChipTile = style({
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  flex: '0 0 auto',
  width: `${ATTACH_TILE}px`,
  height: `${ATTACH_TILE}px`,
  borderRadius: vars.radiusXl,
  background: vars.bgHover,
  color: vars.fgMuted,
  overflow: 'hidden',
  transition: 'background 120ms ease',
});

globalStyle(`${attachChipTile} svg`, {
  width: `${ATTACH_TILE_GLYPH}px`,
  height: `${ATTACH_TILE_GLYPH}px`,
});

globalStyle(`${attachChip}:hover ${attachChipTile}`, {
  background: vars.bgPress,
});

globalStyle(`${attachChip}:focus-visible ${attachChipTile}`, {
  background: vars.bgPress,
});

/** 图片型:缩略图铺满图块本身,圆角由图块切。 */
export const attachChipThumb = style({
  width: '100%',
  height: '100%',
  display: 'block',
  objectFit: 'cover',
});

/**
 * 名字 —— 在方框外面,一行,放不下就省略号。
 * owner:「没必要有这么长的文件名吧,文件名点击不就知道了吗」⇒ 截断是有意的,全名在 title 里。
 */
export const attachChipName = style({
  width: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'center',
  // @@@type-chrome (Refs #6104) — 文件名在这里是**标记**不是正文(真要看全名点开就知道,见上面那段 owner 原话)
  // ⇒ 标记档(#7333:标注 12/18),不是正文档。
  fontSize: vars.typeChromeTinyFontSize,
  lineHeight: `${ATTACH_LABEL_LINE}px`,
  color: vars.fgMuted,
});


export const cardFadeOverlay = style({
  background: `linear-gradient(to top, ${cardSurface} 0%, color-mix(in oklab, ${cardSurface}, transparent 50%) 40%, transparent 100%)`,
  pointerEvents: 'none',
  position: 'absolute',
  right: 0,
  bottom: 0,
  left: 0,
  height: '32px',
  borderBottomLeftRadius: vars.radiusMd,
  borderBottomRightRadius: vars.radiusMd,
});
