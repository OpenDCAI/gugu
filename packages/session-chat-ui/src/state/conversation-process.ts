import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import { parseConversationLink } from '@gugu/core/shared/ui/guguLink';
import { parseHookNotice } from '@session-chat/lib/hook-notice';
import type { ChatItem, ChatMessage, TranscriptTurn, TurnProcessItem } from '@session-chat/model';
import type { TurnProcessHeader } from './turn-fold';

/** Bind a process segment to its reply; notices retain their own status row. */
export function conversationProcessReply(header: TurnProcessHeader | null, tail: readonly ChatItem[]): ChatMessage | null {
  const reply = tail[0];
  if (!header || reply?.kind !== 'message' || reply.role !== 'assistant'
    || !reply.text.trim() || isGuguSilence(reply.text) || parseHookNotice(reply.text)) return null;
  return { ...reply, conversationProcess: { id: header.id, ...(header.live ? { live: true } : {}), startedAt: header.startedAt, endedAt: header.endedAt } };
}

/**
 * Who started a live turn, when it was not the owner typing — the process line says what the agent is busy with
 * (butler 10-28: the owner's typed message must not look blocked by something he did not start). Older records have
 * no `trigger`: an agent-initiated turn reads as background work, a user turn as before.
 */
export function processTrigger(turn: Pick<TranscriptTurn, 'initiator' | 'trigger' | 'items'>): TurnProcessItem['trigger'] {
  const trigger = turn.trigger ?? (turn.initiator === 'agent' ? { kind: 'agent' as const } : undefined);
  if (!trigger || trigger.kind === 'owner') return undefined;
  if (!trigger.chatIds?.length) return { kind: trigger.kind };
  // `chatIds` 是信封里的 `chat=`(公开号,Claude 205 10-28),宿主按对话 id 认群名:从这一轮自己的群投递信封里换过去。
  // 换不到的(私聊、认不出)原样留着,宿主认不出就只写「处理收到的消息」,❌ 把私聊当群。
  const groups = new Map<string, string>();
  for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    for (const { facts } of readDeliveryEnvelope(item.text)?.segments ?? []) {
      const chatId = facts?.chatKind === 'group' && facts.sourceLink ? parseConversationLink(facts.sourceLink)?.chatId : undefined;
      if (chatId && facts?.chat) groups.set(facts.chat, chatId);
    }
  }
  return { kind: trigger.kind, chatIds: trigger.chatIds.map(id => groups.get(id) ?? id) };
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
