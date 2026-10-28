/**
 * agent-send.css.ts — agent 经 message_send / session_message 说的那段话下面那一行去向。
 *
 * ⚠️ 尺寸都要留在 `AGENT_SEND_TO_ROW_H` 里:这一行的 `measure()` 是常量,画高了不会长高,只会被裁掉。
 */
import { style } from '@vanilla-extract/css';
import { vars } from '@session-chat/styles/theme.css';

export const toRow = style({
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
  height: '18px',
  fontSize: '12px',
  lineHeight: '18px',
  color: vars.fgMuted,
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  userSelect: 'none',
});
