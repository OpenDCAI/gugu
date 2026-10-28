import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';

/**
 * View-only reply anchors; persisted messages and delivery envelopes stay untouched.
 * Only explicit anchors are quoted: a delivery's `reply_to`, or the `reply_to_message_id` the agent passed
 * to message_send (`sentReplyTo`). ❌ Falling back to "the input before it" — a direct output has no
 * reply target, and a guessed one reads as a reply to someone else (owner 10-28 新管家截图).
 */
/** 被引用那条在群里说的 ⇒ 那个群的对话 id(人读群名用);私聊没有。 */
function groupOf(facts: DeliveryReadFacts | null | undefined): string | undefined {
  return facts?.chatKind === 'group' && facts.sourceLink ? parseConversationLink(facts.sourceLink)?.chatId : undefined;
}

export function conversationMessages(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  const messages = new Map<string, { item: ChatMessage; text: string; from?: string; self?: boolean; chatId?: string }>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    const data = item as ChatMessage;
    const envelope = readDeliveryEnvelope(item.text);
    const first = envelope?.segments[0]?.facts;
    messages.set(item.id, { item: data, text: envelope?.body ?? data.text, from: first?.from ?? undefined, self: data.role === 'assistant' || undefined, chatId: groupOf(first) });
    for (const segment of envelope?.segments ?? []) {
      const canonical = segment.facts?.messageId?.replace(/^msg:/, '');
      if (canonical) messages.set(canonical, { item: data, text: segment.body, from: segment.facts?.from ?? undefined, chatId: groupOf(segment.facts) });
    }
    const sentId = /:sent:([^:]+)$/.exec(item.id)?.[1];
    if (sentId) messages.set(sentId, { item: data, text: data.text, self: true });
  }
  return turns.map(turn => ({ ...turn, items: turn.items.map(item => {
    if (item.kind !== 'message') return item;
    const data = item as ChatMessage;
    const quoted = readDeliveryEnvelope(item.text)?.segments[0]?.facts?.replyTo?.messageId.replace(/^msg:/, '') ?? data.sentReplyTo;
    const original = quoted ? messages.get(quoted) : undefined;
    if (!original) return item;
    const conversationReply = { itemId: original.item.id, text: original.text, ...(original.from ? { from: original.from } : {}), ...(original.self ? { self: true } : {}), ...(original.chatId ? { chatId: original.chatId } : {}) };
    return { ...item, conversationReply };
  }) }));
}
