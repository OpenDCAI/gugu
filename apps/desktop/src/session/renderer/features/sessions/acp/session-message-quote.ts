import type { ChatMessage } from '@gugu/session-chat-ui';
import { parseMessageQuoteLink, type MessageQuoteSource } from '@gugu/core/shared/ui/messageQuote';

/** One source only: a real IM link, or the original native item. */
export function sessionMessageQuoteSource(message: ChatMessage, sessionId: string): MessageQuoteSource | null {
  if (message.guguDelivery) {
    if (message.guguDelivery.segments.length !== 1) return null;
    const facts = message.guguDelivery.segments[0]?.facts;
    const source = facts?.sourceLink ? parseMessageQuoteLink(facts.sourceLink) : null;
    if (source?.kind === 'chat') return source;
  }
  return message.id && !message.id.startsWith('optimistic:') ? { kind: 'session', sessionId, itemId: message.id } : null;
}

/** Undefined: this row has no selection. Null: a selection crosses message boundaries. */
export function selectedMessageText(root: HTMLElement, selection: Selection | null): string | null | undefined {
  if (!selection || selection.isCollapsed || !selection.rangeCount || !selection.toString().trim()) return undefined;
  const start = root.contains(selection.anchorNode), end = root.contains(selection.focusNode);
  if (start && end) return selection.toString();
  return start || end || selection.getRangeAt(0).intersectsNode(root) ? null : undefined;
}
