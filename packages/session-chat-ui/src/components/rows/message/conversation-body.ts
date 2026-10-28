import type { ChatMessage } from '@session-chat/model';

/** 折着的气泡下面那一行「展开全文」的高(UserMessageCard 画、ConversationMessage 量)。 */
export const CONVERSATION_EXPAND_H = 24;

/** 对话布局里这条有没有要画的正文或附件:只有过程、一个字没回的那一轮没有气泡,也不留时间那一行。 */
export function hasConversationBody(item: ChatMessage): boolean {
  return Boolean(item.streaming || item.text?.trim() || item.attachments?.length);
}
