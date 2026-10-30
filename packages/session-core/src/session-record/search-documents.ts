import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { SearchTaskDocument } from '@gugu/core/shared/search/types';
import { messageReferenceId } from '../acp/models/turns/message-reference';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { agentSendOf, replyItems, successfulMessageSend } from './reply-process';

/** Visible conversation bodies only. Canonical IM messages are indexed by their own account read. */
export function taskSearchDocuments(taskId: string, turn: TranscriptTurn, storedAt: string): SearchTaskDocument[] {
  return replyItems(turn).flatMap(item => {
    let text: string;
    let role: 'user' | 'assistant';
    if (item.kind === 'message') {
      role = item.role;
      const envelope = role === 'user' ? readDeliveryEnvelope(item.text) : null;
      text = envelope ? envelope.segments.filter(segment => !segment.facts?.messageId).map(segment => segment.body).join('\n\n') : item.text;
    } else {
      if (!('toolCallId' in item) || item.status !== 'done' || successfulMessageSend(item)) return [];
      const send = agentSendOf(item, turn);
      if (!send) return [];
      text = send.text;
      role = 'assistant';
    }
    if (!text.trim()) return [];
    const reference = messageReferenceId(turn, item.id) ?? item.id;
    const at = item.kind === 'message' ? item.at ?? turn.startedAt : turn.startedAt;
    return [{ id: `task:${taskId}:${reference}`, taskId, reference, seq: turn.seq, role, text,
      createdAt: at === undefined ? (/^\d{4}-\d{2}-\d{2} /.test(storedAt) ? storedAt.replace(' ', 'T') + 'Z' : storedAt) : new Date(at).toISOString() }];
  });
}
