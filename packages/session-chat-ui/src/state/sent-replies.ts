import { replyItems, replySend, replySource, sentMessageId, successfulMessageSend } from '@gugu/session-core/session-record/reply-process';
import type { TranscriptTurn } from '@session-chat/model';

/** Keep successfully delivered replies readable when their tool process is folded. */
export function withSentReplies(turn: TranscriptTurn, options: { allDestinations?: boolean } = {}): TranscriptTurn {
  const source = replySource(turn, undefined, { includeThreads: true });
  if (!source && !options.allDestinations) return turn;
  const items = replyItems(turn);
  const texts = new Set(items.filter(item => item.kind === 'message' && item.role === 'assistant').map(item => item.kind === 'message' ? item.text.trim() : ''));
  const seen = new Set<string>();
  const replies: TranscriptTurn['items'] = [];
  const after = new Map<string, TranscriptTurn['items']>();
  for (const item of items) {
    if (item.kind !== 'mcp-tool-call' || item.status !== 'done') continue;
    const send = options.allDestinations ? successfulMessageSend(item) : source ? replySend(item, source) : null;
    const id = sentMessageId(item);
    if (!send || !id || !send.text.trim() || texts.has(send.text.trim()) || seen.has(id)) continue;
    seen.add(id);
    const replyTo = 'replyTo' in send ? send.replyTo : undefined;
    const reply = { kind: 'message' as const, id: `${item.id}:sent:${id}`, seq: item.seq, role: 'assistant' as const, text: send.text, ...(replyTo ? { sentReplyTo: replyTo } : {}) };
    replies.push(reply);
    if (options.allDestinations) {
      const container = turn.items.find(parent => parent.id === item.id || (parent.kind === 'tool-group' && replyItems({ ...turn, items: [parent] }).some(child => child.id === item.id)));
      if (container) after.set(container.id, [...(after.get(container.id) ?? []), reply]);
    }
  }
  if (!replies.length) return turn;
  return { ...turn, items: options.allDestinations ? turn.items.flatMap(item => [item, ...(after.get(item.id) ?? [])]) : [...turn.items, ...replies] };
}
