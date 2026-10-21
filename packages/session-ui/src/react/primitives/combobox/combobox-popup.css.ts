import { globalStyle, style } from '@vanilla-extract/css';
import { durMed, easeStandard, kfPopupIn } from '@session-ui/styles/effects/animations.css';
import { popupShadow } from '@session-ui/styles/recipes/popup-surface.css';
import { vars } from '@session-ui/theme/core/contract/contract.css';
import { tokenVars } from '@session-ui/theme/tokens.css';

// @提及 / 斜杠命令的弹层。取值本来就是浮层表达那一份(逐字节相同),这里只是不再自己抄一遍。
// ❌ 不组合 popupSurface:这个弹层由 TipTap 的 suggestion 插件按 clientRect 定位,
// 没有 Base UI 的 `[data-side]`/`[data-open]` 属性,那套按 side 分支的入场动画在它身上
// 一条都不会命中 —— 它有自己的单条 kfPopupIn。
export const popupRoot = style([
  popupShadow,
  {
    zIndex: 50,
    minWidth: '220px',
    maxWidth: '340px',
    overflow: 'hidden',
    // design.md shape 表:@提及 / 斜杠弹层是浮层面 ⇒ --radius-surface(10px)。
    borderRadius: tokenVars.radiusSurface,
    // Keep suggestion menus opaque even when the portal is mounted above the
    // transcript. A translucent inherited surface lets markdown and tool rows
    // bleed through the list and makes same-name file entries unreadable.
    backgroundColor: vars.surfaceElevated,
    color: vars.foreground,
    animation: `${kfPopupIn} ${durMed} ${easeStandard} both`,
  },
]);

export const popupHeader = style({
  borderBottom: `1px solid ${vars.border}`,
  paddingLeft: '0.5rem',
  paddingRight: '0.5rem',
  paddingTop: '0.375rem',
  paddingBottom: '0.375rem',
  fontSize: tokenVars.textTiny,
  color: vars.foregroundMuted,
});

export const popupList = style({
  maxHeight: '240px',
  scrollPaddingTop: '0.25rem',
  scrollPaddingBottom: '0.25rem',
  overflowY: 'auto',
  padding: '0.25rem',
});

export const popupItem = style({
  position: 'relative',
  display: 'flex',
  width: '100%',
  cursor: 'default',
  userSelect: 'none',
  alignItems: 'center',
  gap: '0.5rem',
  borderRadius: tokenVars.radiusSm,
  // @@@aui-item —— 上游 `px-3 py-2`(0.75rem / 0.5rem);右侧留给 Enter 提示。
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
  paddingLeft: '0.75rem',
  paddingRight: '2rem',
  fontSize: tokenVars.textSm,
  outline: 'none',
});

export const popupItemStacked = style({
  alignItems: 'flex-start',
  paddingRight: '0.5rem',
});

export const popupItemTextStack = style({
  display: 'flex',
  minWidth: 0,
  flex: '1 1 0%',
  flexDirection: 'column',
  gap: '0.125rem',
});

export const popupItemDefault = style({
  color: vars.foreground,
  textAlign: 'center',
});

// @@@aui-section-header —— 上游:`text-muted-foreground border-b px-3 py-2 text-xs tracking-wide uppercase`。
export const popupSectionHeader = style({
  paddingTop: '0.5rem',
  paddingBottom: '0.5rem',
  paddingLeft: '0.75rem',
  paddingRight: '0.75rem',
  fontSize: tokenVars.textTiny,
  fontWeight: 500,
  letterSpacing: '0.05em',
  textTransform: 'uppercase',
  borderBottom: `1px solid ${vars.surfaceHover}`,
  color: vars.foregroundMuted,
});

/** 用字重代替图标区分条目(见 ComboboxPopupItem.strong)。 */
export const popupItemLabelStrong = style({
  fontWeight: 600,
});

export const popupItemHighlighted = style({
  backgroundColor: vars.surfaceHover,
  color: vars.foreground,
});

export const popupItemHover = style({
  color: vars.foreground,
  selectors: {
    '&:hover': { backgroundColor: vars.surfaceHover },
  },
});

export const popupItemIcon = style({
  display: 'flex',
  flexShrink: 0,
  alignItems: 'center',
  fontSize: '1em',
});
globalStyle(`${popupItemIcon} svg`, { width: '1rem', height: '1rem' });

export const popupItemAvatar = style({
  display: 'flex',
  width: '1.25rem',
  height: '1.25rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: '50%',
  backgroundColor: `color-mix(in srgb, ${vars.foreground} 6%, transparent)`,
  color: `color-mix(in srgb, ${vars.foreground} 45%, transparent)`,
  fontSize: '0.5625rem',
  fontWeight: 500,
  lineHeight: 1,
});

export const popupItemLabel = style({
  // Keep the primary label visible before allowing the description/path to take space.
  flexGrow: 1,
  flexShrink: 0,
  flexBasis: 'auto',
  minWidth: 0,
  maxWidth: '100%',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
});

/**
 * 高亮那一行右侧的 `↵` 提示 —— 上游 `composer-slash-commands` 的解剖:
 * 「active rows receive background tint plus ↵ hint」。
 *
 * `marginLeft: auto` 把它顶到行尾;`flexShrink: 0` 保证它永远不被描述文字挤没
 * —— 挤没了这个提示就成了「有时有有时没有」,那比不做更让人困惑。
 */
export const popupItemEnterHint = style({
  marginLeft: 'auto',
  flexShrink: 0,
  paddingLeft: '0.5rem',
  fontSize: tokenVars.textTiny,
  lineHeight: 1,
  color: vars.foregroundMuted,
});

export const popupItemDescription = style({
  // High flex-shrink so the muted description ellipsizes before the (short)
  // primary label, keeping the command/mention name visible.
  flexGrow: 0,
  flexShrink: 100,
  flexBasis: 'auto',
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  fontSize: tokenVars.textTiny,
  color: vars.foregroundMuted,
});

export const popupItemDescriptionMono = style([
  popupItemDescription,
  {
    fontFamily: tokenVars.fontMono,
    letterSpacing: '-0.025em',
  },
]);

export const popupItemRole = style({
  flexShrink: 0,
  marginLeft: 'auto',
  fontFamily: tokenVars.fontMono,
  fontSize: '0.6875rem',
  letterSpacing: '-0.025em',
  color: vars.foregroundMuted,
});

export const popupDismiss = style({
  display: 'inline-flex',
  width: '1rem',
  height: '1rem',
  flexShrink: 0,
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: tokenVars.radiusSm,
  opacity: 0.5,
  selectors: {
    '&:hover': { opacity: 1 },
  },
});
