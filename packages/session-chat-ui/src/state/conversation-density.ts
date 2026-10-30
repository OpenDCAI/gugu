import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseMessageQuoteLink } from '@gugu/core/shared/ui/messageQuote';
import type { ChatMessage } from '@session-chat/model';
import type { RenderUnit } from '@session-chat/core/units';

/** Presentation follows visible messages, never process rows or completion notices. */
export function conversationSpeaker(item: ChatMessage): string | undefined {
  if (item.role === 'assistant') return '$agent';
  const delivery = item.guguDelivery ?? readDeliveryEnvelope(item.text);
  return delivery ? delivery.segments.at(-1)?.facts?.fromId ?? undefined : item.role === 'user' ? '$owner' : undefined;
}

export function lastConversationMessage(units: readonly RenderUnit[]): ChatMessage | undefined {
  for (let i = units.length - 1; i >= 0; i--) {
    const item = units[i]?.data as ChatMessage;
    if (units[i]?.kind === 'message' && item.conversationPart !== 'head' && !item.conversationNarration
      && !item.hookNotice && !item.questionAnswer && (item.role === 'user' || item.role === 'assistant')) return item;
  }
}

/** Direct model output has no reference chrome; message transport also requires an explicit anchor. */
export function messageReplyReference(item: ChatMessage): ChatMessage['conversationReply'] | null {
  if (item.conversationPart === 'body' || !item.conversationReply) return null;
  const delivered = item.guguDelivery ?? readDeliveryEnvelope(item.text);
  const quotedInput = item.role === 'user' && parseMessageQuoteLink(item.conversationReply.itemId);
  return item.sentReplyTo || item.sentTo || item.sentChat || delivered || quotedInput ? item.conversationReply : null;
}

export function decorateConversationDensity(units: RenderUnit[], previous?: ChatMessage): RenderUnit[] {
  for (const unit of units) {
    if (unit.kind === 'turn-process') { unit.data = { ...(unit.data as object), conversationPreviousSpeaker: previous && conversationSpeaker(previous) }; continue; }
    if (unit.kind !== 'message') continue;
    const item = unit.data as ChatMessage;
    if (item.conversationNarration || item.hookNotice || item.questionAnswer || (item.role !== 'user' && item.role !== 'assistant')) continue;
    unit.data = { ...item, conversationPreviousSpeaker: previous && conversationSpeaker(previous) };
    if (item.conversationPart !== 'head') previous = item;
  }
  return units;
}
