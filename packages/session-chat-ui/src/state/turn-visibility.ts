import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import type { TranscriptTurn } from '@session-chat/model';

/** Inputs are retained separately. Reasoning alone is not a reply, tool or card. */
export function isEmptyAgentTurn(turn: TranscriptTurn): boolean {
  if (turn.outcome && turn.outcome.kind !== 'done') return false;
  return turn.items.every(item => {
    if (item.kind === 'thinking') return true;
    if (item.kind !== 'message') return false;
    if (item.role === 'user') return true;
    return !item.attachments?.length && (!item.text.trim() || isGuguSilence(item.text));
  });
}
