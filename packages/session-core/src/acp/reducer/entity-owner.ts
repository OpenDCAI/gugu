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
    const visit = (items: readonly TranscriptItem[]): boolean => items.some(item => {
      if (event.kind === 'message') return event.messageId !== null && item.id === makeMessageId(turn.id, event.messageId, event.role);
      if (event.kind === 'thinking') return event.messageId !== null && item.id === makeThinkingId(turn.id, event.messageId);
      if (event.kind === 'plan') return item.kind === 'create-plan-tool-call' && item.planId === (event.planId ?? SESSION_PLAN_ID);
      if ('toolCallId' in item && item.toolCallId === event.toolCallId && item.kind !== 'subagent-done-tool-call') return true;
      return 'children' in item && item.children !== undefined && visit(item.children);
    });
    return visit(turn.items);
  };
  if (transcript.active && contains(transcript.active)) return transcript.active;
  for (let i = transcript.committed.length - 1; i >= 0; i--) if (contains(transcript.committed[i])) return transcript.committed[i];
}
