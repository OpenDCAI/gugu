import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';

export type MessageSenderTarget = { kind: 'chat'; chatId: string; messageId?: string }
  | { kind: 'session'; sessionId: string } | { kind: 'sender'; userId: string; sourceChatId?: string };

export function conversationAgentTarget(facts: { sessionId?: string | null; userId?: string | null }): MessageSenderTarget | null {
  if (facts.sessionId) return { kind: 'session', sessionId: facts.sessionId };
  return facts.userId ? { kind: 'sender', userId: facts.userId } : null;
}

/** Group provenance wins over the sender's private identity. Never resolve a display name as an address. */
export function messageSenderTarget(facts: { fromId?: string | null; chatKind?: string | null; sourceLink?: string | null } | null | undefined): MessageSenderTarget | null {
  if (!facts) return null;
  const source = facts.sourceLink ? parseConversationLink(facts.sourceLink) : null;
  if (source && (facts.chatKind === 'group' || facts.chatKind === 'topic')) return { kind: 'chat', ...source };
  const match = /^(user|session):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(facts.fromId ?? '');
  if (!match) return null;
  return match[1].toLowerCase() === 'session' ? { kind: 'session', sessionId: match[2] } : { kind: 'sender', userId: match[2] };
}
