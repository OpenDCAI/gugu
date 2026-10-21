import type { SessionpageMessageHost } from '@shared/sessionpage-message-host';

/**
 * 宿主(咕咕消息面)挂在 window 上的那一口:往私聊发消息 / 附件、把咕咕切到某个 Agent 的私聊。
 * 建任务的首句(对话页创建)与模式按钮的「聊天」(#7167)都经这里,❌ 各自去 window 上摸一遍。
 */
export function sessionpageMessageHost(): SessionpageMessageHost {
  const host = (window as typeof window & {
    __GUGU_SESSIONPAGE_MESSAGES__?: SessionpageMessageHost;
  }).__GUGU_SESSIONPAGE_MESSAGES__;
  if (!host) throw new Error('Session-page message host is unavailable');
  return host;
}
