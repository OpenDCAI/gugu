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

/** One visible output per segment; retain source records and non-message work. */
export function conversationOutput(items: readonly ChatItem[]): { reply: ChatMessage | null; rest: ChatItem[] } {
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
  return {
    // Stable identity prevents replacement of the bubble when a new provider
    // message carries the result of the tool call.
    reply: first && latest ? { ...latest, id: first.id } : null,
    rest: items.filter(item => !ids.has(item.id)),
  };
}
