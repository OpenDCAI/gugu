import { globalStyle, style } from '@vanilla-extract/css';
import { collapseHeader } from '@session-chat/components/primitives/collapse-header.css';
import { summaryChip } from '@session-chat/components/primitives/summary-chip.css';
import { toolName } from '../tools/tool/tool.css';
import { vars } from '@session-chat/styles/theme.css';

export const conversationRoot = style({ position: 'relative', color: vars.fgBody });
export const conversationHeader = style({ display: 'flex', alignItems: 'center', gap: 8, paddingBottom: 6, boxSizing: 'border-box', minWidth: 0, overflow: 'hidden', fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize, lineHeight: '18px' });
export const conversationName = style({ fontWeight: 650, whiteSpace: 'nowrap', maxWidth: '52%', overflow: 'hidden', textOverflow: 'ellipsis', flexShrink: 0 });
export const conversationDivider = style({ width: 1, height: 10, background: vars.border, flexShrink: 0 });
export const conversationQuote = style({ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0, maxWidth: '55%', padding: 0, border: 0, background: 'transparent', color: vars.fgMuted, font: 'inherit', cursor: 'pointer', selectors: { '&:hover': { color: vars.fgBody }, '&:focus-visible': { outline: `1px solid ${vars.fgMuted}`, outlineOffset: 2 } } });
export const conversationActions = style({ position: 'absolute', bottom: 0, right: 48, opacity: 0, pointerEvents: 'none', selectors: { [`${conversationRoot}:hover &`]: { opacity: 1, pointerEvents: 'auto' }, [`${conversationRoot}:focus-within &`]: { opacity: 1, pointerEvents: 'auto' } } });
export const conversationTime = style({ display: 'flex', alignItems: 'center', gap: 9, color: vars.fgMuted, fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize });
globalStyle(`${conversationQuote} span`, { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' });
globalStyle(`${conversationQuote} svg`, { flexShrink: 0, fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationHeader}`, { justifyContent: 'flex-end' });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationName}`, { order: 3 });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationDivider}`, { order: 2 });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationQuote}`, { order: 1 });
globalStyle(`${conversationRoot}[data-side="right"] ${conversationTime}`, { justifyContent: 'flex-end' });
globalStyle(`${conversationRoot} [data-user-card]`, { background: 'var(--bubble-mine, var(--chat-bubble-user))', color: vars.fgBody, borderColor: 'transparent' });
globalStyle(`${conversationRoot}[data-side="left"] [data-user-card]`, { background: 'var(--bubble-other, var(--chat-bg-2))' });

globalStyle(`${conversationRoot}[data-side="left"] ${conversationActions}`, { right: 'auto', left: 48 });

globalStyle(`${conversationActions} [data-user-message-actions]`, { opacity: 1, pointerEvents: 'auto' });

export const conversationProcessButton = style({ display: 'inline-flex', alignItems: 'center', gap: 5, height: 22, padding: 0, border: 0, background: 'transparent', color: vars.fgMuted, font: 'inherit', fontVariantNumeric: 'tabular-nums', cursor: 'pointer', whiteSpace: 'nowrap', selectors: { '&:hover': { color: vars.fg }, '&:focus-visible': { outline: `1px solid ${vars.fgMuted}`, outlineOffset: 2, borderRadius: 3 } } });
export const conversationProcessChevron = style({ display: 'inline-block', lineHeight: 1, transition: 'transform 120ms ease', selectors: { [`${conversationProcessButton}[aria-expanded="true"] &`]: { transform: 'rotate(90deg)' } }, '@media': { '(prefers-reduced-motion: reduce)': { transition: 'none' } } });
globalStyle(`${conversationProcessButton} svg`, { flexShrink: 0 });
// Copy/edit controls float above the footer rather than covering the process disclosure.
globalStyle(`${conversationRoot}:has([data-conversation-process]) ${conversationActions}`, { bottom: 24, left: 'auto', right: 0 });

// Process labels share the conversation's auxiliary typography; code bodies retain monospace.
for (const label of [collapseHeader, toolName, summaryChip]) {
  globalStyle(`[data-chat-root][data-agent-conversation="true"] ${label}`, {
    fontFamily: vars.fontSans, fontSize: vars.typeChromeTinyFontSize,
  });
}
