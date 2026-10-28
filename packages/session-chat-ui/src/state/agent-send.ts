/**
 * agent 经 message_send / session_message 说出去的那段话,发到了哪里 —— 那一行去向怎么写。
 * 桌面(`agent-send.def`)与手机会话页(`agent-send-part`)读的都是这一份;哪些调用算、去向怎么认在 session-core `agentSendOf`。
 * 纯函数,不碰 Solid / React。
 */
import type { AgentSendTarget } from '@gugu/session-core/session-record/reply-process';
import type { ChatTranslator } from '@session-chat/localization';

/**
 * 去向那一句。群名由宿主按对话 id 给(同「来自 X 群」那张投递卡);认不出来就只说「发到聊天里」,❌ 写群号。
 * 发到话题:这条会话绑在那个话题上,话落在那里(服务器按会话定,agent 选不了)。
 */
export function agentSendLabel(to: AgentSendTarget, translate: ChatTranslator, chatName: (chatId: string) => string | null): string {
  if (to.kind === 'session') {
    return to.count > 1 ? translate('transcript.agentSendToSessions', { count: to.count }) : translate('transcript.agentSendToSession');
  }
  const chat = to.conversationId ? chatName(to.conversationId) : null;
  if (to.whisper) return chat ? translate('transcript.agentSendWhisperIn', { chat }) : translate('transcript.agentSendWhisper');
  if (to.threadRootId) return chat ? translate('transcript.agentSendToThreadIn', { chat }) : translate('transcript.agentSendToThread');
  return chat ? translate('transcript.agentSendTo', { chat }) : translate('transcript.agentSendToChat');
}
