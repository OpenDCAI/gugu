import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import { parseHookNotice } from '@session-chat/lib/hook-notice';
import type { ChatItem, ChatMessage } from '@session-chat/model';
import type { TurnProcessHeader } from './turn-fold';

/** Bind a process segment to its reply; notices retain their own status row. */
export function conversationProcessReply(header: TurnProcessHeader | null, tail: readonly ChatItem[]): ChatMessage | null {
  const reply = tail[0];
  if (!header || reply?.kind !== 'message' || reply.role !== 'assistant'
    || !reply.text.trim() || isGuguSilence(reply.text) || parseHookNotice(reply.text)) return null;
  return { ...reply, conversationProcess: { id: header.id, ...(header.live ? { live: true } : {}), startedAt: header.startedAt, endedAt: header.endedAt } };
}

/**
 * One reply bubble per segment, plus every message_send output as its own bubble (`sent`);
 * `rest` is the process work that folds under the process line.
 */
export function conversationOutput(items: readonly ChatItem[]): { reply: ChatMessage | null; sent: ChatMessage[]; rest: ChatItem[] } {
  let outputs = items.filter((item): item is ChatMessage => item.kind === 'message'
    && item.role === 'assistant' && !item.id.includes(':sent:') && !('guguDelivery' in item && item.guguDelivery)
    && !!item.text.trim() && !isGuguSilence(item.text) && !parseHookNotice(item.text));
  // A group reply can exist only as a confirmed message_send projection,
  // followed by [NO_REPLY]. Bind that delivered bubble to the process too.
  if (outputs.length === 0) {
    const delivered = items.find((item): item is ChatMessage => item.kind === 'message'
      && item.role === 'assistant' && item.id.includes(':sent:') && !!item.text.trim());
    if (delivered) outputs = [delivered];
  }
  const first = outputs[0];
  const latest = outputs.at(-1);
  const ids = new Set(outputs.map(item => item.id));
  // owner 10-28:message_send 发出去的那几条是这一轮的输出,各自一个气泡,❌ 折进过程里、展开才看得到。
  const sent = first ? items.filter((item): item is ChatMessage => item.kind === 'message' && item.role === 'assistant'
    && item.id.includes(':sent:') && !ids.has(item.id) && !!item.text.trim()) : [];
  for (const item of sent) ids.add(item.id);
  return {
    // Stable identity prevents replacement of the bubble when a new provider
    // message carries the result of the tool call.
    reply: first && latest ? { ...latest, id: first.id } : null,
    sent,
    rest: items.filter(item => !ids.has(item.id)),
  };
}
