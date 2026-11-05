import { readDeliveryEnvelope } from './deliveryEnvelope';

export function deliverySourceIds(text: string): string[] {
  return readDeliveryEnvelope(text)?.segments.flatMap(segment => segment.facts?.messageId
    ? [segment.facts.messageId.replace(/^msg:/, '')] : []) ?? [];
}

/** Stable input identities only: identical prose, a reply or a partial batch is not a receipt. */
export function matchesDeliveryIdentity(input: { id: string; text: string },
  message: { id: string; text: string; clientMessageId?: string | null }): boolean {
  if (message.clientMessageId === input.id || message.id === input.id
    || (input.id.length >= 16 && message.id.includes(input.id))) return true;
  const ids = deliverySourceIds(input.text);
  if (!ids.length) return false;
  const native = new Set(deliverySourceIds(message.text));
  return ids.every(id => native.has(id));
}
