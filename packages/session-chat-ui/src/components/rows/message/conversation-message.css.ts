import { globalStyle, style } from '@vanilla-extract/css';
import { collapseHeader } from '@session-chat/components/primitives/collapse-header.css';
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';
import { toolName } from '../tools/tool/tool.css';
import { cardFadeOverlay } from './user-message.css';
import { vars } from '@session-chat/styles/theme.css';

export const conversationRoot = style({ position: 'relative', color: vars.fgBody });
export const conversationHeader = style({ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6, boxSizing: 'border-box', minWidth: 0, overflow: 'hidden', fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize, lineHeight: '18px' });
export const conversationName = style({ fontWeight: 650, whiteSpace: 'nowrap', maxWidth: '52%', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 });
/** 气泡上方一行引用:「谁 · 摘要」,单行截断(owner 10-28:要看得出是谁说的)。 */
export const conversationQuote = style({ display: 'flex', alignItems: 'center', gap: 5, boxSizing: 'border-box', paddingBottom: 4, minWidth: 0, maxWidth: '86%', overflow: 'hidden', whiteSpace: 'nowrap', color: vars.fgMuted, fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize, lineHeight: '18px' });
globalStyle(`${conversationQuote} > span:last-child`, { overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 });
globalStyle(`${conversationQuote} svg`, { flexShrink: 0, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 });
export const conversationQuoteFrom = style({ fontWeight: 600, flexShrink: 0, maxWidth: '60%', overflow: 'hidden', textOverflow: 'ellipsis' });
export const conversationTime = style({ display: 'flex', alignItems: 'center', gap: 9, color: vars.fgMuted, fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationHeader}`, { justifyContent: 'flex-end' });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationName}`, { order: 3 });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationTime}`, { justifyContent: 'flex-end' });
// 人那一侧复用原来的用户气泡:`--chat-bubble-user` 作底、`--chat-bubble-user-fg` 作字(会话页是反色,深色模式自动反过来)。
// owner 10-28:设计稿规则「复用之前的消息气泡」优先于示意图里的浅灰(`--bubble-mine` #ebebeb)。
// 要自己一套颜色的宿主(助理 App、手机外观)设 `--conversation-bubble-mine(-fg)`。
const MINE_BG = 'var(--conversation-bubble-mine, var(--chat-bubble-user))';
const MINE_FG = 'var(--conversation-bubble-mine-fg, var(--chat-bubble-user-fg))';
globalStyle(`${conversationRoot} [data-user-card]`, { background: MINE_BG, color: vars.fgBody, borderColor: 'transparent' });
globalStyle(`${conversationRoot}[data-side="right"] [data-user-card]`, { vars: { [vars.fgBody]: MINE_FG, [vars.link]: MINE_FG } });
globalStyle(`${conversationRoot}[data-side="left"] [data-user-card]`, { background: 'var(--bubble-other, var(--chat-bg-2))' });



export const conversationProcessButton = style({ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: 0, border: 0, background: 'transparent', color: vars.fgMuted, font: 'inherit', fontVariantNumeric: 'tabular-nums', cursor: 'pointer', whiteSpace: 'nowrap', selectors: { '&:hover': { color: vars.fg }, '&:focus-visible': { outline: `1px solid ${vars.fgMuted}`, outlineOffset: 2, borderRadius: 3 } } });
export const conversationProcessChevron = style({ display: 'inline-block', lineHeight: 1, transition: 'transform 120ms ease', selectors: { [`${conversationProcessButton}[aria-expanded="true"] &`]: { transform: 'rotate(90deg)' } }, '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } } });
globalStyle(`${conversationProcessButton} svg`, { flexShrink: 0 });
/** 过程行里「执行中」与「后台 · …」之间那道细竖线。 */
export const conversationTimeSeparator = style({ width: 1, height: 10, background: vars.border, flexShrink: 0 });

// Process labels share the conversation's auxiliary typography; code bodies retain monospace.
for (const label of [collapseHeader, toolName, summaryChip]) {
  globalStyle(`[data-chat-root][data-agent-conversation="true"] ${label}`, {
    fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize,
  });
}

// owner 定稿(0 号图):对话布局照样复用原气泡 ——
// 时间、复制、编辑那一行常驻在气泡下面(不是悬停才出);agent 那边靠左,复制在前、时间在后。
globalStyle(`${conversationRoot} [data-user-message-actions]`, { opacity: 1, pointerEvents: 'auto' });
globalStyle(`${conversationRoot}[data-side="left"] [data-user-message-actions]`, { justifyContent: 'flex-start' });
globalStyle(`${conversationRoot}[data-side="left"] [data-user-message-actions] time`, { order: 2, marginLeft: 8, marginRight: 0 });
// 折着的长消息淡出成气泡自己的底色(浅色),❌ 淡成原用户气泡的深色 —— 那就是一条黑带。
globalStyle(`${conversationRoot} ${cardFadeOverlay}`, {
  // 0 号图里淡出要拖过两三行,32px 那条太短,像被裁掉。
  height: 96,
  background: `linear-gradient(to top, ${MINE_BG} 0%, transparent 100%)`,
});
globalStyle(`${conversationRoot}[data-side="left"] ${cardFadeOverlay}`, {
  background: 'linear-gradient(to top, var(--bubble-other, var(--chat-bg-2)) 0%, transparent 100%)',
});
