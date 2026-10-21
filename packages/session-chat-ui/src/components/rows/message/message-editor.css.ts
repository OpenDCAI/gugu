import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';
import { MESSAGE_EDITOR_BUTTON_HEIGHT, MESSAGE_EDITOR_GAP, MESSAGE_EDITOR_PADDING } from './message-editor-metrics';

export const messageEditor = style({
  boxSizing: 'border-box', width: '100%', display: 'flex', flexDirection: 'column',
  padding: MESSAGE_EDITOR_PADDING, gap: MESSAGE_EDITOR_GAP, borderRadius: vars.radiusThread,
  background: `color-mix(in srgb, ${vars.bg} 93%, ${vars.fgBody})`, color: vars.fgBody,
});
export const messageEditorText = style({
  display: 'block', boxSizing: 'border-box', flexShrink: 0, width: '100%', padding: 0, margin: 0,
  border: 'none', outline: 'none', resize: 'none', background: 'transparent', color: 'inherit',
  fontFamily: vars.typeBodyFontFamily, fontSize: vars.typeBodyFontSize,
  fontWeight: vars.typeBodyFontWeight, lineHeight: vars.typeBodyLineHeight,
  whiteSpace: 'pre-wrap', overflowWrap: 'break-word',
});
export const messageEditorActions = style({ display: 'flex', justifyContent: 'flex-end', gap: 8, height: MESSAGE_EDITOR_BUTTON_HEIGHT, flexShrink: 0 });
export const messageEditorButton = style({
  height: MESSAGE_EDITOR_BUTTON_HEIGHT, padding: '0 14px', border: 'none', borderRadius: vars.radiusFull,
  background: vars.bg, color: vars.fg, fontFamily: vars.fontSans, fontSize: vars.typeChromeFontSize, cursor: 'pointer',
  selectors: { '&:disabled': { opacity: 0.45, cursor: 'default' }, '&:focus-visible': { outline: `2px solid ${vars.fgMuted}`, outlineOffset: 2 } },
});
export const messageEditorSend = style({ background: vars.fgBody, color: vars.bg });
