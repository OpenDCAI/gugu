import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { replyItems, replyProcess, replySend } from './reply-process';

/** Ephemeral, source-bound reply progress from the live runtime; never restored from record archives. */
export type SessionLiveReply = {
  sourceMessageId: string;
  activity: { phase: 'thinking'; id: string; startedAt: number; text: string } | { phase: 'replying' }
    | { phase: 'tools'; count: number }
    | { phase: 'draft'; id: string; text: string; replyToMessageId?: string };
};

export function liveReplyOf(turn: TranscriptTurn | null): SessionLiveReply | null {
  if (!turn || turn.outcome || turn.endedAt !== undefined) return null;
  const input = turn.items.filter((item) => item.kind === 'message' && item.role === 'user').at(-1);
  if (!input || input.kind !== 'message') return null;
  const delivery = readDeliveryEnvelope(input.text);
  if (!delivery || delivery.segments.length !== 1) return null;
  const facts = delivery.segments[0]?.facts;
  if (facts?.route !== 'chat' || !facts.messageId || facts.thread) return null;
  const item = replyItems(turn).at(-1);
  if (item && 'toolCallId' in item && item.status !== 'error') {
    const send = replySend(item, facts);
    if (send?.text) return { sourceMessageId: facts.messageId, activity: { phase: 'draft', id: item.id, ...send } };
  }
  if (item?.kind === 'thinking' && item.status === 'thinking' && Number.isFinite(item.startedAt)) {
    return { sourceMessageId: facts.messageId, activity: { phase: 'thinking', id: item.id, startedAt: item.startedAt, text: item.text } };
  }
  if (item?.kind === 'message' && item.role === 'assistant') return { sourceMessageId: facts.messageId, activity: { phase: 'replying' } };
  const count = replyProcess(turn).tools;
  if (count > 0) return { sourceMessageId: facts.messageId, activity: { phase: 'tools', count } };
  return null;
}
