import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import type { ChatMessage, TranscriptTurn } from '@session-chat/model';

/** 被引用那条在群里说的 ⇒ 那个群的对话 id(人读群名用);私聊没有。 */
function groupOf(facts: DeliveryReadFacts | null | undefined): string | undefined {
  return facts?.chatKind === 'group' && facts.sourceLink ? parseConversationLink(facts.sourceLink)?.chatId : undefined;
}

type Quoted = { item: ChatMessage; text: string; from?: string; fromId?: string; self?: boolean; chatId?: string };

/**
 * View-only reply anchors; persisted messages and delivery envelopes stay untouched.
 * Only explicit anchors are quoted: a delivery's `reply_to`, or the `reply_to_message_id` the agent passed
 * to message_send (`sentReplyTo`). ❌ Falling back to "the input before it" — a direct output has no
 * reply target, and a guessed one reads as a reply to someone else (owner 10-28 新管家截图).
 */
export function conversationMessages(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  // 群号 / 对话 id → 对话 id,只收这段记录里见过的群投递:agent 自己发出去的那条只知道它填的 chat_id,
  // 认得出是个群才写群名;❌ 认不出就按群猜(私聊的 chat_id 也长这样)。
  const groups = new Map<string, string>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    for (const segment of readDeliveryEnvelope(item.text)?.segments ?? []) {
      const chatId = groupOf(segment.facts);
      if (!chatId) continue;
      groups.set(chatId, chatId);
      if (segment.facts?.chat) groups.set(segment.facts.chat, chatId);
    }
  }
  const messages = new Map<string, Quoted>();
  for (const turn of turns) for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    const data = item as ChatMessage;
    const envelope = readDeliveryEnvelope(item.text);
    const first = envelope?.segments[0]?.facts;
    messages.set(item.id, { item: data, text: envelope?.body ?? data.text, from: first?.from ?? undefined, fromId: first?.fromId ?? undefined, self: data.role === 'assistant' || undefined, chatId: groupOf(first) });
    for (const segment of envelope?.segments ?? []) {
      const canonical = segment.facts?.messageId?.replace(/^msg:/, '');
      if (canonical) messages.set(canonical, { item: data, text: segment.body, from: segment.facts?.from ?? undefined, fromId: segment.facts?.fromId ?? undefined, chatId: groupOf(segment.facts) });
    }
    const sentId = /:sent:([^:]+)$/.exec(item.id)?.[1];
    if (sentId) messages.set(sentId, { item: data, text: data.text, self: true, chatId: data.sentChat ? groups.get(data.sentChat) : undefined });
  }
  return turns.map(turn => ({ ...turn, items: turn.items.map(item => {
    if (item.kind !== 'message') return item;
    const data = item as ChatMessage;
    const quoted = readDeliveryEnvelope(item.text)?.segments[0]?.facts?.replyTo?.messageId.replace(/^msg:/, '') ?? data.sentReplyTo;
    const original = quoted ? messages.get(quoted) : undefined;
    if (!original) return item;
    const conversationReply = { itemId: original.item.id, text: original.text, ...(original.from ? { from: original.from } : {}),
      ...(original.fromId ? { fromId: original.fromId } : {}), ...(original.self ? { self: true } : {}), ...(original.chatId ? { chatId: original.chatId } : {}) };
    return { ...item, conversationReply };
  }) }));
}
