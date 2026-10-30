import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { replyItems, replySend, replySource, sourceChatMatches, successfulMessageSend } from './reply-process';
import { sentAttachmentOf, type AttachmentTurn } from './sent-attachment';

/** An explicit private reply owns that conversation's output; a following task summary is not displayed. */
export function visibleConversationItems(turn: TranscriptTurn): TranscriptItem[] {
  const source = replySource(turn, undefined, { includeThreads: true });
  if (source?.chatKind !== 'dm') return turn.items;
  const items = replyItems(turn);
  const lastReply = items.findLastIndex(item => {
    if (item.kind !== 'mcp-tool-call') return false;
    if (successfulMessageSend(item) && replySend(item, source)) return true;
    if (!sentAttachmentOf(item, (turn as AttachmentTurn).sentAttachments)) return false;
    try { return sourceChatMatches(source, (JSON.parse(item.rawInput ?? '{}') as { chat_id?: unknown }).chat_id); }
    catch { return false; }
  });
  const summaries = new Set(lastReply < 0 ? [] : items.slice(lastReply + 1)
    .filter(item => item.kind === 'message' && item.role === 'assistant' && !/:sent:/.test(item.id)).map(item => item.id));
  return summaries.size ? turn.items.filter(item => !summaries.has(item.id)) : turn.items;
}
