import type { ChatMessage } from '@session-chat/model';
import type { MeasureCtx } from '@session-chat/core/define';
import type { UnitsView } from '@session-chat/state/flatten';

export function isConversationMessage(item: ChatMessage, ctx: Pick<MeasureCtx, 'theme'>): boolean {
  if (!ctx.theme.layout?.agentConversation || item.hookNotice || item.questionAnswer || item.role === 'thought') return false;
  return !item.guguDelivery || item.guguDelivery.segments.every(segment => segment.facts?.route === 'chat' || segment.facts?.route === 'session-direct');
}

export function latestConversationBubbleId(units: UnitsView, ctx: Pick<MeasureCtx, 'theme'>): string | null {
  for (let i = units.length - 1; i >= 0; i--) {
    const unit = units.at(i);
    if (unit?.kind !== 'message') continue;
    const item = unit.data as ChatMessage;
    if (!isConversationMessage(item, ctx) || item.conversationPart === 'head'
      || item.conversationNarration || !hasConversationBody(item)) continue;
    const count = item.guguDelivery?.segments.length ?? 0;
    return count > 1 ? `${item.id}:batch-${count - 1}` : item.id;
  }
  return null;
}

/** Persist the reader's choice by actual message identity, not the mutable live/stored row prefix. */
export function conversationBubbleKey(item: ChatMessage): string {
  const messageId = item.guguDelivery?.segments.length === 1 ? item.guguDelivery.segments[0]?.facts?.messageId : undefined;
  const batch = /:batch-\d+$/.exec(item.id)?.[0] ?? '';
  return `conversation-bubble:${messageId ?? (item.sourceItemId ? item.sourceItemId + batch : item.id)}`;
}

/** 对话布局里名字那一行、过程行的高(ConversationMessage 与只有过程的那一行 turn-process 共用,两边一样高才没有空白)。 */
export const CONVERSATION_HEADER_H = 24;
export const CONVERSATION_PROCESS_H = 22;

/** 气泡下面那排时间、复制、编辑的高(不含上面的间隙);没回话那一轮末尾的复制也是这一排(#1041)。 */
export const CONVERSATION_FOOTER_H = 16;

/** 折着的气泡下面那一行「展开全文」的高(UserMessageCard 画、ConversationMessage 量)。 */
export const CONVERSATION_EXPAND_H = 24;
/** 过程里 agent 中途说的话:一行灰字(设计稿 0 号),❌ 一个气泡。 */
export const CONVERSATION_NARRATION_H = 32;

export const conversationNarrationText = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ');
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat;
};
/** message_send 带了 reply_to_message_id 时气泡上方那一行引用「谁 · 摘要」。 */
export const CONVERSATION_QUOTE_H = 22;

/**
 * 气泡下面那一行(时间、复制)画不画:没有正文不画;agent 一轮里拆出来的气泡只有收了口的最后一句画
 * (设计稿 0 号 tail,owner 10-28「中途的气泡平时不带操作行」)。人那一侧照旧都有。
 */
export function hasConversationActions(item: ChatMessage): boolean {
  if (!hasConversationBody(item)) return false;
  // 每条发送气泡保留悬停操作;去处由气泡底部显示。
  return !(item.role === 'assistant' && item.conversationPart === 'body' && !item.conversationTail && !item.sentTo);
}

/** 对话布局里这条有没有要画的正文或附件:只有过程、一个字没回的那一轮没有气泡,也不留时间那一行。 */
export function hasConversationBody(item: ChatMessage): boolean {
  return Boolean(item.streaming || item.text?.trim() || item.attachments?.length);
}
