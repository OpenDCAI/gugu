import type { TranscriptTurn } from '@gugu/session-core/acp';
import { indexHermesPrompts, originalHermesPrompt } from '@gugu/session-core/acp/hermes-prompt';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

/** A native row proves receipt; the host row only proves where that row's original user text starts. */
export function hermesRecordedDeliveryIds(native: readonly TranscriptTurn[], stored: readonly TranscriptTurn[]): string[] | null {
  const originals = indexHermesPrompts(stored.flatMap((turn) => turn.items));
  const ids = new Set<string>();
  for (const item of native.flatMap((turn) => turn.items)) {
    if (item.kind !== 'message' || item.role !== 'user') continue;
    const original = originalHermesPrompt(item.text, originals);
    if (original === null) return null;
    const reading = readDeliveryEnvelope(original ?? item.text);
    // An old merged row without a host boundary is unknown, never evidence of an empty inbox.
    if (!reading && original === undefined && /<gugu_deliver(?:y|ies)[\s>]/.test(item.text)) return null;
    for (const segment of reading?.segments ?? []) if (segment.facts?.messageId) ids.add(segment.facts.messageId);
  }
  return [...ids];
}
