import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { catalogCall } from '../acp/models/turns/tool-calls';
import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { agentSendOf, messageSendTargetOf, replyItems, sourceChatMatches,
  successfulGuguSendMessageId, successfulMessageSend, successfulSessionSend, type AgentSendTarget } from './reply-process';

/** Original addressing facts. A missing recipient list is unknown, not a broadcast. */
export type SendAddresses = {
  target: AgentSendTarget;
  recipients: readonly string[] | null;
  recipientsExplicit?: boolean;
  chatKind: string | null;
  replyTo: Pick<DeliveryReadFacts, 'fromId' | 'fromType' | 'messageId'> | null;
  confirmed: boolean;
};

function addresses(value: unknown): readonly string[] | null {
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return Array.isArray(value) && value.every(id => typeof id === 'string' && id.trim()) ? value : null;
}

/** Read the last actual input preceding this send, never a later steered input. */
function precedingDelivery(item: TranscriptItem, turn?: TranscriptTurn): DeliveryReadFacts | null {
  if (!turn) return null;
  const items = replyItems(turn), end = items.findIndex(candidate => candidate.id === item.id);
  if (end < 0) return null;
  const input = items.slice(0, end).findLast(candidate => candidate.kind === 'message' && candidate.role === 'user');
  return input?.kind === 'message' ? readDeliveryEnvelope(input.text)?.segments.at(-1)?.facts ?? null : null;
}

/** Preserve typed recipients separately from display names and transport previews. */
export function sendAddressesOf(item: TranscriptItem, turn?: TranscriptTurn): SendAddresses | null {
  if (item.kind !== 'mcp-tool-call' || item.parentToolCallId || item.status === 'error') return null;
  // A completed transport can report a partial failure without the outer tool being status=error.
  const send = agentSendOf(item, turn) ?? (item.status === 'done' ? agentSendOf({ ...item, status: 'running' }, turn) : null);
  const target = send?.to ?? messageSendTargetOf(item, turn);
  if (!target) return null;
  try {
    const args = (catalogCall(item.tool, item.rawInput)?.args ?? JSON.parse(item.rawInput ?? '')) as Record<string, unknown>;
    if (!args || typeof args !== 'object') return null;
    const source = precedingDelivery(item, turn);
    const here = target.kind === 'chat' && source?.route === 'chat'
      && (sourceChatMatches(source, args.chat_id) || !!target.conversationId && sourceChatMatches(source, target.conversationId));
    const reply = typeof args.reply_to_message_id === 'string' ? args.reply_to_message_id.replace(/^msg:/, '') : null;
    const replyTo = here && reply && source.messageId?.replace(/^msg:/, '') === reply
      ? { fromId: source.fromId, fromType: source.fromType, messageId: source.messageId } : null;
    let recipients = target.kind === 'session' ? addresses(args.to) : addresses(args.to_user_ids);
    if (target.kind === 'chat' && args.to_user_ids === undefined) {
      if (typeof args.chat_id === 'string' && args.chat_id.startsWith('user:')) recipients = [args.chat_id];
      else if (replyTo?.fromId) recipients = [replyTo.fromId];
      else if (here && (source.chatKind === 'dm' || source.chatKind === 'ai') && source.fromId) recipients = [source.fromId];
      // Only a known group without explicit recipients is a broadcast.
      else if (here && (source.chatKind === 'group' || source.chatKind === 'topic')) recipients = [];
    }
    const confirmed = item.status === 'done' && (target.kind === 'session'
      ? successfulSessionSend(item) !== null
      : successfulMessageSend(item) !== null || successfulGuguSendMessageId(item) !== null);
    return { target, recipients, recipientsExplicit: target.kind === 'session' ? args.to !== undefined : args.to_user_ids !== undefined,
      chatKind: here ? source.chatKind : null, replyTo, confirmed };
  } catch { return null; }
}
