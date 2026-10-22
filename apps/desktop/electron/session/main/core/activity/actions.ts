import { z } from 'zod';
import type { ActivityQuery } from '@shared/core/activity';
import { activityJournal } from './collector';

export type ActivityAction = ({ action: 'activity_list' } & ActivityQuery)
  | { action: 'activity_context'; event_id: string; before_seq?: number };
export function isActivityAction(action: { action: string }): action is ActivityAction {
  return action.action === 'activity_list' || action.action === 'activity_context';
}
export async function runActivityAction(action: ActivityAction) {
  const journal = activityJournal();
  if (action.action === 'activity_list') {
    const { action: _, ...query } = action;
    return journal.list(query);
  }
  const event = journal.get(z.string().min(1).max(512).parse(action.event_id));
  if (!event.session_id) throw new Error('This activity has no session context; use its source object');
  // The only path that opens a transcript. Kept dynamically separate from metadata queries.
  const before = z.number().int().nonnegative().optional().parse(action.before_seq);
  const anchored = event.turn_id !== undefined && before === undefined;
  const { recordHistoryPage } = await import('@main/core/session-timeline/service');
  const context = await recordHistoryPage({ conversationId: event.session_id, limit: 4,
    ...(anchored ? { atTurnId: event.turn_id } : {}), ...(before !== undefined ? { beforeSeq: before } : {}) });
  if (!context.ok) return { event, context_available: false, reason: context.error };
  if (typeof context.value === 'string') return { event, context_available: false, reason: context.value };
  return { event, context_available: true, scope: anchored ? 'event_turn' : before !== undefined ? 'older_turns' : 'latest_four_turns', event_anchored: anchored,
    note: 'Source records are read now and may have changed. Unanchored windows are not event-time reconstructions. Claims of completion require verification.',
    has_older: context.value.hasOlder,
    next_before_seq: context.value.hasOlder ? context.value.turns.at(0)?.seq ?? null : null,
    context: context.value.turns.map(turn => ({ id: turn.id, sequence: turn.seq, started_at: turn.startedAt ?? null,
      ended_at: turn.endedAt ?? null, outcome: turn.outcome?.kind ?? null,
      inputs: turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [{ id: item.id, text: item.text }] : []),
      latest_reply: [...turn.items].reverse().flatMap(item => item.kind === 'message' && item.role === 'assistant'
        ? [{ id: item.id, text: item.text, at: item.at ?? null }] : []).at(0) ?? null })) };
}
