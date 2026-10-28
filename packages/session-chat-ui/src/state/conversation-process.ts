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

/** An assistant text the agent said itself (not a message_send projection, a delivery, silence or a hook notice). */
function isSpoken(item: ChatItem): item is ChatMessage {
  return item.kind === 'message' && item.role === 'assistant' && !item.id.includes(':sent:')
    && !('guguDelivery' in item && item.guguDelivery) && !!item.text.trim() && !isGuguSilence(item.text) && !parseHookNotice(item.text);
}

/**
 * The turn's outputs: the reply bubble, every message_send output as its own bubble (`sent`), and `rest` —
 * the process work that folds under the process line.
 *
 * Design 0 (owner 10-28): what the agent says along the way is a gray line among the steps, alternating with
 * the step groups; only the **last** thing it said in a finished turn is the reply bubble. While the turn runs
 * there is no reply yet — every line it has said is narration (`live`). Earlier lines stay in `rest`
 * (flagged `conversationNarration`), ❌ dropped when the turn closes, ❌ merged into one updating bubble.
 */
export function conversationOutput(items: readonly ChatItem[], live = false): { reply: ChatMessage | null; sent: ChatMessage[]; rest: ChatItem[] } {
  const spoken = items.filter(isSpoken);
  // A group reply can exist only as a confirmed message_send projection,
  // followed by [NO_REPLY]. Bind that delivered bubble to the process too.
  const delivered = spoken.length === 0 && !live ? items.find((item): item is ChatMessage => item.kind === 'message'
    && item.role === 'assistant' && item.id.includes(':sent:') && !!item.text.trim()) : undefined;
  const reply = live ? null : spoken.at(-1) ?? delivered ?? null;
  // owner 10-28:message_send 发出去的那几条是这一轮的输出,各自一个气泡,❌ 折进过程里、展开才看得到。
  const sent = items.filter((item): item is ChatMessage => item.kind === 'message' && item.role === 'assistant'
    && item.id.includes(':sent:') && item !== reply && !!item.text.trim());
  const out = new Set<ChatItem>([...sent, ...(reply ? [reply] : [])]);
  return {
    reply,
    sent,
    rest: items.filter(item => !out.has(item)).map(item => isSpoken(item) ? { ...item, conversationNarration: true } : item),
  };
}
