import { createHash, randomUUID } from 'node:crypto';

/** Host-owned retry identity. The sender and target scope it before the durable inbox deduplicates it. */
export function sessionDirectMessageId(sender: string, target: string, delivery: { delivery_id?: string; delivery_at?: string }): string {
  if (delivery.delivery_id === undefined && delivery.delivery_at === undefined) return randomUUID();
  if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(delivery.delivery_id ?? '')
    || typeof delivery.delivery_at !== 'string' || !Number.isFinite(Date.parse(delivery.delivery_at))) {
    throw new Error('durable session delivery requires a UUID and its original timestamp');
  }
  const hex = createHash('sha256').update(JSON.stringify([sender, target, delivery.delivery_id])).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
