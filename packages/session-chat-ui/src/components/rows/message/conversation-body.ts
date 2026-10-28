import type { ChatMessage } from '@session-chat/model';

/** 对话布局里名字那一行、过程行的高(ConversationMessage 与只有过程的那一行 turn-process 共用,两边一样高才没有空白)。 */
export const CONVERSATION_HEADER_H = 24;
export const CONVERSATION_PROCESS_H = 22;

/** 折着的气泡下面那一行「展开全文」的高(UserMessageCard 画、ConversationMessage 量)。 */
export const CONVERSATION_EXPAND_H = 24;
/** 过程里 agent 中途说的话:一行灰字(设计稿 0 号),❌ 一个气泡。 */
export const CONVERSATION_NARRATION_H = 32;

export const conversationNarrationText = (text: string): string => text.replace(/\s+/g, ' ').slice(0, 160);
/** message_send 带了 reply_to_message_id 时气泡上方那一行引用「谁 · 摘要」。 */
export const CONVERSATION_QUOTE_H = 22;

/**
 * 气泡下面那一行(时间、复制)画不画:没有正文不画;agent 一轮里拆出来的气泡只有收了口的最后一句画
 * (设计稿 0 号 tail,owner 10-28「中途的气泡平时不带操作行」)。人那一侧照旧都有。
 */
export function hasConversationActions(item: ChatMessage): boolean {
  if (!hasConversationBody(item)) return false;
  // 发出去的那几条也带:那一行最前面常驻「发到 群名」(管家 10-28),时间、复制照旧悬停才出。
  return !(item.role === 'assistant' && item.conversationPart === 'body' && !item.conversationTail && !item.sentTo);
}

/** 对话布局里这条有没有要画的正文或附件:只有过程、一个字没回的那一轮没有气泡,也不留时间那一行。 */
export function hasConversationBody(item: ChatMessage): boolean {
  return Boolean(item.streaming || item.text?.trim() || item.attachments?.length);
}
