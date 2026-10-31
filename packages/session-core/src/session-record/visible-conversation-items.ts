import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import { replyItems } from './reply-process';

/** Direct output stays visible after transport sends; only the shared silence marker hides a message. */
export function visibleConversationItems(turn: TranscriptTurn): TranscriptItem[] {
  return replyItems(turn).filter(item => item.kind !== 'message' || item.role !== 'assistant' || !isGuguSilence(item.text));
}
