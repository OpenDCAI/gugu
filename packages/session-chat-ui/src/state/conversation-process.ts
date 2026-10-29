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
 * Called after segmentation: the last spoken text is a bubble even while running.
 * A confirmed send overrides it. Earlier spoken texts remain process narration.
 */
export function conversationOutput(items: readonly ChatItem[], _live = false): { reply: ChatMessage | null; sent: ChatMessage[]; rest: ChatItem[]; steps: ChatItem[]; silent: boolean } {
  const spoken = items.filter(isSpoken);
  // A group reply can exist only as a confirmed message_send projection,
  // followed by [NO_REPLY]. Bind that delivered bubble to the process too.
  const delivered = items.findLast((item): item is ChatMessage => item.kind === 'message'
    && item.role === 'assistant' && item.id.includes(':sent:') && !!item.text.trim());
  const reply = delivered ?? spoken.at(-1) ?? null;
  // owner 10-28:message_send 发出去的那几条是这一轮的输出,各自一个气泡,❌ 折进过程里、展开才看得到。
  const sent = items.filter((item): item is ChatMessage => item.kind === 'message' && item.role === 'assistant'
    && item.id.includes(':sent:') && item !== reply && !!item.text.trim());
  const out = new Set<ChatItem>([...sent, ...(reply ? [reply] : [])]);
  // 发出去的那条已经是气泡了:它的 message_send 调用 ❌ 在过程里再画一遍同一句话(MBP 验收 10-28「完成」出现两次)。
  const sentCalls = new Set([...out].map(item => /^(.*):sent:[^:]+$/.exec(item.id)?.[1]).filter((id): id is string => id !== undefined));
  return {
    reply,
    sent,
    silent: !reply && items.some(item => item.kind === 'message' && isGuguSilence(item.text)),
    rest: items.filter(item => !out.has(item) && !sentCalls.has(item.id)
      && !(item.kind === 'message' && (!item.text.trim() || isGuguSilence(item.text))))
      .map(item => isSpoken(item) ? { ...item, conversationNarration: true } : item),
    // 「N 步」数的是干的活:发消息的那几次调用算(它们不在 rest 里,画成了气泡),中途说的话不算 ——
    // 否则最后一句在跑完那一下先算进来再退出去,步数 3→4→3 跳一下(MBP 验收 10-28)。
    steps: items.filter(item => (item.kind === 'tool' || 'toolCallId' in item) && item.kind !== 'subagent-done-tool-call' && item.kind !== 'background-command-done-tool-call'),
  };
}
