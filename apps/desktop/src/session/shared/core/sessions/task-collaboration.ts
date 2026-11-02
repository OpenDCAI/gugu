import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

/** A saved session-direct delivery. It is a read projection, never another delivery. */
export type TaskExchange = {
  id: string;
  position: number;
  sourceMessageId?: string | null;
  fromSessionId: string;
  toSessionId: string;
  content: string;
  createdAt: string;
};

export type TaskExchangeRequest = {
  conversationId: string;
  fromSessionId: string;
  after?: number;
};
export type TaskExchangePage = { entries: TaskExchange[]; cursor: number; hasMore: boolean };

export function taskExchangeFromRow(row: {
  id: string; position: number; sessionId: string; content: string; timestamp: string; metadata: string | null;
  /** The message's one receipt (session-life's pending row, or the legacy outbox's for legs not on it yet). */
  receipt: string | null;
}, fromSessionId: string): TaskExchange | null {
  let metadata: { kind?: string };
  try { metadata = JSON.parse(row.metadata ?? 'null'); } catch { return null; }
  if (metadata?.kind !== 'session-direct' || row.receipt !== 'accepted') return null;
  const reading = readDeliveryEnvelope(row.content);
  if (!reading || reading.segments.length !== 1) return null;
  const segment = reading.segments[0]!;
  if (segment.facts?.route !== 'session-direct' || segment.facts.fromId !== `session:${fromSessionId}`) return null;
  const createdAt = /(?:Z|[+-]\d\d:\d\d)$/.test(row.timestamp)
    ? row.timestamp : `${row.timestamp.replace(' ', 'T')}Z`;
  if (!Number.isFinite(Date.parse(createdAt))) return null;
  return { id: row.id, position: row.position, fromSessionId, toSessionId: row.sessionId, content: segment.body, createdAt };
}
