import { parseDeliveryTimestamp, readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { SearchTaskDocument } from '@gugu/core/shared/search/types';
import { messageReferenceId } from '../acp/models/turns/message-reference';
import type { TranscriptTurn } from '../acp/models/turns/turn';
import { visibleConversationItems } from './visible-conversation-items';
import { agentSendOf, replyItems, successfulMessageSend } from './reply-process';

/** Visible conversation bodies only. Canonical IM messages are indexed by their own account read. */
export function taskSearchDocuments(taskId: string, turn: TranscriptTurn): SearchTaskDocument[] {
  return replyItems({ ...turn, items: visibleConversationItems(turn) }).flatMap(item => {
    const reference = messageReferenceId(turn, item.id);
    if (!reference) return [];
    const document = (text: string, role: 'user' | 'assistant', at: number | string | null | undefined,
      senderId?: string | null, identity = reference): SearchTaskDocument[] => {
      if (!text.trim()) return [];
      const time = typeof at === 'string' ? Date.parse(at) : at;
      return [{ id: `task:${taskId}:${identity}`, taskId, reference, seq: turn.seq, role, text,
        ...(senderId !== undefined ? { senderId } : {}),
        createdAt: typeof time === 'number' && Number.isFinite(time) ? new Date(time).toISOString() : null }];
    };
    if (item.kind === 'message') {
      const envelope = item.role === 'user' ? readDeliveryEnvelope(item.text) : null;
      // Only chat deliveries have their canonical copy in the account message index.
      // Other routes also carry messageId, but their visible body belongs to this task.
      if (envelope) return envelope.segments.flatMap((segment, index) => segment.facts?.route === 'chat' ? []
        : document(segment.body, item.role, parseDeliveryTimestamp(segment.facts?.at) ?? item.at ?? turn.startedAt,
          segment.facts?.fromId?.replace(/^user:/, '') ?? null,
          segment.facts?.messageId ? `delivery:${turn.seq}:${segment.facts.route}:${segment.facts.messageId}` : `${reference}:delivery:${index}`));
      return document(item.text, item.role, item.at ?? turn.startedAt);
    }
    if (item.kind !== 'mcp-tool-call' || item.status !== 'done' || successfulMessageSend(item)) return [];
    const send = agentSendOf(item, turn);
    return send ? document(send.text, 'assistant', item.completedAt ?? turn.startedAt) : [];
  });
}
