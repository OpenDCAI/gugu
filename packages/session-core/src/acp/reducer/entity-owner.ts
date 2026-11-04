import type { TranscriptItem, TranscriptTurn } from '../models/turns';
import { makeMessageId, makeThinkingId } from './ids';
import { SESSION_PLAN_ID } from '../models/plan';
import type { NormalizedEvent } from './normalized-event';

/** Entity identity, rather than whichever turn happens to be active, owns updates. */
export function findEntityOwner(
  transcript: { active: TranscriptTurn | null; committed: readonly TranscriptTurn[] },
  event: NormalizedEvent,
): TranscriptTurn | undefined {
  if (event.kind !== 'message' && event.kind !== 'thinking' && event.kind !== 'tool_call' && event.kind !== 'tool_update' && event.kind !== 'plan') return;
  const contains = (turn: TranscriptTurn): boolean => {
    // 消息 / 思维要问的是「这个 id 在不在这回合里」,而那个 id 只由**回合 id 与事件**决定,与条目无关
    // ⇒ 在遍历外算一次。原先它写在 `some` 里,于是每个条目都重建一个字符串再比 —— 而这条路是
    // 「每来一个流式片段、每个条目走一次」(见 `reduce`,#1181)。
    const wanted = event.kind === 'message'
      ? event.messageId === null ? null : makeMessageId(turn.id, event.messageId, event.role)
      : event.kind === 'thinking'
        ? event.messageId === null ? null : makeThinkingId(turn.id, event.messageId)
        : null;
    const visit = (items: readonly TranscriptItem[]): boolean => items.some(item => {
      if (event.kind === 'message' || event.kind === 'thinking') return wanted !== null && item.id === wanted;
      if (event.kind === 'plan') return item.kind === 'create-plan-tool-call' && item.planId === (event.planId ?? SESSION_PLAN_ID);
      if ('toolCallId' in item && item.toolCallId === event.toolCallId && item.kind !== 'subagent-done-tool-call') return true;
      return 'children' in item && item.children !== undefined && visit(item.children);
    });
    return visit(turn.items);
  };
  if (transcript.active && contains(transcript.active)) return transcript.active;
  for (let i = transcript.committed.length - 1; i >= 0; i--) if (contains(transcript.committed[i])) return transcript.committed[i];
}
