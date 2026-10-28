import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';

/** View-only reply anchors; persisted messages and delivery envelopes stay untouched. */
export function conversationMessages(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  const messages = new Map<string, ChatMessage>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    const data = item as ChatMessage;
    messages.set(item.id, data);
    for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) {
      const canonical = segment.facts?.messageId?.replace(/^msg:/, '');
      if (canonical) messages.set(canonical, data);
    }
    const sentId = /:sent:([^:]+)$/.exec(item.id)?.[1];
    if (sentId) messages.set(sentId, data);
  }
  return turns.map(turn => {
    let input: ChatMessage | undefined;
    return { ...turn, items: turn.items.map(item => {
      if (item.kind !== 'message') return item;
      const facts = readDeliveryEnvelope(item.text)?.segments[0]?.facts;
      const quoted = facts?.replyTo?.messageId.replace(/^msg:/, '');
      const original = quoted ? messages.get(quoted) : item.role === 'assistant' ? input : undefined;
      if (item.role === 'user') input = item as ChatMessage;
      if (!original) return item;
      const conversationReply = { itemId: original.id, text: readDeliveryEnvelope(original.text)?.body ?? original.text };
      return { ...item, conversationReply };
    }) };
  });
}
