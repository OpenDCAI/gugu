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
    // 对话布局(allDestinations):发到群里的那一句和这一轮最后说的话撞了字也是两条输出,❌ 当成同一条丢掉 ——
    // 丢了它就既不是气泡、又在过程里画成一张「Claude 1 · 完成」(MBP 验收 10-28 第六轮)。
    if (!send || !id || !send.text.trim() || (!options.allDestinations && texts.has(send.text.trim())) || seen.has(id)) continue;
    seen.add(id);
    const replyTo = 'replyTo' in send ? send.replyTo : undefined;
    const chat = 'chat' in send ? send.chat : undefined;
    const reply = { kind: 'message' as const, id: `${item.id}:sent:${id}`, seq: item.seq, role: 'assistant' as const, text: send.text,
      ...(replyTo ? { sentReplyTo: replyTo } : {}), ...(chat ? { sentChat: chat } : {}) };
    replies.push(reply);
    if (options.allDestinations) {
      const container = turn.items.find(parent => parent.id === item.id || (parent.kind === 'tool-group' && replyItems({ ...turn, items: [parent] }).some(child => child.id === item.id)));
      if (container) after.set(container.id, [...(after.get(container.id) ?? []), reply]);
    }
  }
  if (!replies.length) return turn;
  return { ...turn, items: options.allDestinations ? turn.items.flatMap(item => [item, ...(after.get(item.id) ?? [])]) : [...turn.items, ...replies] };
}
