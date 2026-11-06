import { isDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptMessage, TranscriptTurn } from '../acp/client';

export type PersonalConversationPreview = { text: string; at: number };

/** Owner steering can open a personal segment inside a delivery-started turn. */
export function personalConversationMessages(turn: TranscriptTurn): TranscriptMessage[] {
  const legacyPersonal = turn.trigger ? turn.trigger.kind === 'owner' : turn.initiator === 'user';
  let personal = legacyPersonal;
  const selected: TranscriptMessage[] = [];
  for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    if (item.role === 'user') {
      const ownerInput = item._meta?.guguOwnerInput;
      personal = typeof ownerInput === 'boolean' ? ownerInput : legacyPersonal && !isDeliveryEnvelope(item.text);
    }
    if (personal || item.ownerNotification) selected.push(item);
  }
  return selected;
}

/** Message time is authoritative; reading/replaying a transcript must never make it new. */
export function personalConversationPreview(turn: TranscriptTurn): PersonalConversationPreview | null {
  let latest: PersonalConversationPreview | null = null;
  for (const item of personalConversationMessages(turn)) {
    const at = item.at ?? (item.role === 'assistant' ? turn.endedAt : turn.startedAt);
    if (!item.text.trim() || item.text.trim() === '[NO_REPLY]' || at === undefined || !Number.isFinite(at) || !Number.isFinite(new Date(at).getTime())) continue;
    // Attachment instructions can contain private local paths.
    const text = item.attachments?.length || /\[(?:Folder file|Image attached at local path:)/.test(item.text) || /@\[[^\]]+\]\(/.test(item.text)
      ? '' : item.text.trim().replace(/\s+/g, ' ').slice(0, 180);
    if (text) latest = { text, at };
  }
  return latest;
}
