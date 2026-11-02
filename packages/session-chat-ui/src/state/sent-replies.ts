import { agentSendOf, replyItems, replySend, replySource, sentMessageId, successfulMessageSend, successfulSessionSend } from '@gugu/session-core/session-record/reply-process';
import { sentAttachmentOf } from '@gugu/session-core/session-record/sent-attachment';
import { sentFileGroups } from '@gugu/session-core/session-record/sent-file-groups';
import type { TranscriptTurn } from '@session-chat/model';

/** Keep successfully delivered replies readable when their tool process is folded. */
export function withSentReplies(turn: TranscriptTurn, options: { allDestinations?: boolean } = {}): TranscriptTurn {
  const source = replySource(turn, undefined, { includeThreads: true });
  const files = sentFileGroups(turn);
  if (!source && !options.allDestinations && !files.length) return turn;
  const items = replyItems(turn);
  const texts = new Set(items.filter(item => item.kind === 'message' && item.role === 'assistant').map(item => item.kind === 'message' ? item.text.trim() : ''));
  const seen = new Set(items.flatMap(item => item.kind === 'message' ? [
    ...(/:sent:([^:]+)$/.exec(item.id)?.slice(1) ?? []), ...((item as import('@session-chat/model').ChatMessage).sentAttachments?.map(file => file.messageId) ?? []),
  ] : []));
  const replies: TranscriptTurn['items'] = [];
  const after = new Map<string, TranscriptTurn['items']>();
  for (const item of items) {
    if (item.kind !== 'mcp-tool-call' || item.status !== 'done') continue;
    const fileGroup = files.find(group => group.first === item);
    const attachment = fileGroup?.attachments[0];
    if (!fileGroup && sentAttachmentOf(item)) continue;
    const session = options.allDestinations ? successfulSessionSend(item) : null;
    const send = attachment ? { id: attachment.messageId, text: fileGroup!.attachments.map(file => file.name).join('\n') } : session ?? (options.allDestinations ? successfulMessageSend(item) : source ? replySend(item, source) : null);
    const id = send && 'id' in send ? send.id : sentMessageId(item);
    // 对话布局(allDestinations):发到群里的那一句和这一轮最后说的话撞了字也是两条输出,❌ 当成同一条丢掉 ——
    // 丢了它就既不是气泡、又在过程里画成一张「Claude 1 · 完成」(MBP 验收 10-28 第六轮)。
    if (!send || !id || !send.text.trim() || (!options.allDestinations && texts.has(send.text.trim())) || seen.has(id)) continue;
    seen.add(id);
    const replyTo = 'replyTo' in send ? send.replyTo : undefined;
    const chat = 'chat' in send ? send.chat : undefined;
    const reply = { kind: 'message' as const, id: `${item.id}:sent:${id}`, seq: item.seq, role: 'assistant' as const, text: send.text, ...(attachment ? { sentAttachment: attachment, sentAttachments: fileGroup!.attachments } : {}),
      ...(item.completedAt !== undefined ? { at: item.completedAt } : {}),
      ...(replyTo ? { sentReplyTo: replyTo } : {}), ...(chat ? { sentChat: chat } : {}) };
    // 对话布局:气泡下面常驻一小段「发到 群名」(管家 10-28),去向与会话页那一行同一个读法。
    const to = fileGroup?.to ?? (options.allDestinations ? agentSendOf(item, turn)?.to : undefined);
    if (to) Object.assign(reply, { sentTo: to });
    replies.push(reply);
    if (options.allDestinations || fileGroup) {
      const last = fileGroup?.last ?? item;
      const container = turn.items.find(parent => parent.id === last.id || (parent.kind === 'tool-group' && replyItems({ ...turn, items: [parent] }).some(child => child.id === last.id)));
      if (container) after.set(container.id, [...(after.get(container.id) ?? []), reply]);
    }
  }
  if (!replies.length) return turn;
  // Direct output remains a separate message after transport sends, including files.
  // Silence markers are hidden by the shared message segmenter, not by send history.
  const positioned = new Set([...after.values()].flat());
  return { ...turn, items: [...turn.items.flatMap(item => [item, ...(after.get(item.id) ?? [])]), ...replies.filter(reply => !positioned.has(reply))] };
}
