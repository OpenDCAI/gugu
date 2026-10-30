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

export function isAdjacentConversationReply(item: ChatMessage, previous?: ChatMessage): boolean {
  const reference = item.conversationReply?.messageId ?? item.conversationReply?.itemId;
  if (!reference || !previous) return false;
  if (reference === previous.id) return true;
  const link = parseMessageQuoteLink(reference);
  if (link?.kind === 'session') return link.itemId === previous.sourceItemId;
  const id = (link?.kind === 'chat' ? link.messageId : reference).replace(/^msg:/, '');
  if (/:sent:([^:]+)$/.exec(previous.id)?.[1] === id) return true;
  const delivery = previous.guguDelivery ?? readDeliveryEnvelope(previous.text);
  return delivery?.segments.at(-1)?.facts?.messageId?.replace(/^msg:/, '') === id;
}

export function decorateConversationDensity(units: RenderUnit[], previous?: ChatMessage): RenderUnit[] {
  for (const unit of units) {
    if (unit.kind === 'turn-process') { unit.data = { ...(unit.data as object), conversationPreviousSpeaker: previous && conversationSpeaker(previous) }; continue; }
    if (unit.kind !== 'message') continue;
    const item = unit.data as ChatMessage;
    if (item.conversationNarration || item.hookNotice || item.questionAnswer || (item.role !== 'user' && item.role !== 'assistant')) continue;
    unit.data = { ...item, conversationPreviousSpeaker: previous && conversationSpeaker(previous),
      conversationReplyAdjacent: isAdjacentConversationReply(item, previous) };
    if (item.conversationPart !== 'head') previous = item;
  }
  return units;
}
