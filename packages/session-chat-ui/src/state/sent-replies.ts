import { replyItems, replySend, replySource, sentMessageId } from '@gugu/session-core/session-record/reply-process';
import type { TranscriptTurn } from '@session-chat/model';

/** Keep successfully delivered replies readable when their tool process is folded. */
export function withSentReplies(turn: TranscriptTurn): TranscriptTurn {
  const source = replySource(turn, { includeThreads: true });
  if (!source) return turn;
  const items = replyItems(turn);
  const texts = new Set(items.filter(item => item.kind === 'message' && item.role === 'assistant').map(item => item.kind === 'message' ? item.text.trim() : ''));
  const seen = new Set<string>();
  const replies: TranscriptTurn['items'] = [];
  for (const item of items) {
    if (item.kind !== 'mcp-tool-call' || item.status !== 'done') continue;
    const send = replySend(item, source);
    const id = sentMessageId(item);
    if (!send || !id || !send.text.trim() || texts.has(send.text.trim()) || seen.has(id)) continue;
    seen.add(id);
    replies.push({ kind: 'message', id: `${item.id}:sent:${id}`, seq: item.seq, role: 'assistant', text: send.text });
  }
  return replies.length ? { ...turn, items: [...turn.items, ...replies] } : turn;
}
