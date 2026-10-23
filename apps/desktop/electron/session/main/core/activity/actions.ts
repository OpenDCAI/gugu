import { z } from 'zod';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import type { ActivityEvent, ActivityQuery } from '@shared/core/activity';
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
  const sessionId = event.session_id;
  if (!sessionId) throw new Error('This activity has no session context; use its source object');
  // The only path that opens a transcript. Kept dynamically separate from metadata queries.
  const before = z.number().int().nonnegative().optional().parse(action.before_seq);
  if (event.turn_seq !== undefined) return storedTurnContext(event, sessionId, event.turn_seq, before);
  const { recordHistoryPage } = await import('@main/core/session-timeline/service');
  const context = await recordHistoryPage({ conversationId: sessionId, limit: 4,
    ...(before !== undefined ? { beforeSeq: before } : {}) });
  if (!context.ok) return { event, context_available: false, reason: context.error };
  if (typeof context.value === 'string') return { event, context_available: false, reason: context.value };
  return { event, context_available: true, source: 'provider_record', scope: before !== undefined ? 'older_turns' : 'latest_four_turns',
    event_anchored: false, note: UNANCHORED_NOTE, has_older: context.value.hasOlder,
    next_before_seq: context.value.hasOlder ? context.value.turns.at(0)?.seq ?? null : null,
    context: context.value.turns.map(contextTurn) };
}

const UNANCHORED_NOTE = 'Source records are read now and may have changed. Unanchored windows are not event-time reconstructions. Claims of completion require verification.';

/**
 * A turn event names a turn of the session's stored history by its stored sequence, so it is read there and only
 * there: the same writer assigned that sequence. Paging older turns stays in the same history.
 */
async function storedTurnContext(event: ActivityEvent, sessionId: string, turnSeq: number, before: number | undefined) {
  const { readStoredTurn, readStoredTurns } = await import('@main/core/sessions/session-turn-store');
  if (before !== undefined || event.kind !== 'session.turn_recorded') {
    const page = await readStoredTurns(sessionId, { limit: 4, ...(before !== undefined ? { before } : {}) });
    return { event, context_available: true, source: 'stored_history', scope: before !== undefined ? 'older_turns' : 'latest_four_turns',
      event_anchored: false, note: UNANCHORED_NOTE, has_older: page.nextCursor !== null, next_before_seq: page.nextCursor,
      context: page.turns.map(contextTurn) };
  }
  if (activityJournal().turnRevertedAfter(event.event_id)) {
    return { event, context_available: false, reason: 'A later revert removed this turn from the conversation.' };
  }
  const turn = await readStoredTurn(sessionId, turnSeq);
  if (!turn) return { event, context_available: false, reason: 'The session\'s stored history no longer has this turn.' };
  const older = await readStoredTurns(sessionId, { before: turnSeq, limit: 1 });
  return { event, context_available: true, source: 'stored_history', scope: 'event_turn', event_anchored: true,
    note: 'The turn this event recorded, as stored now. Claims of completion require verification.',
    has_older: older.turns.length > 0, next_before_seq: older.turns.length > 0 ? turnSeq : null, context: [contextTurn(turn)] };
}

function contextTurn(turn: TranscriptTurn) {
  return { id: turn.id, sequence: turn.seq, started_at: turn.startedAt ?? null,
    ended_at: turn.endedAt ?? null, outcome: turn.outcome?.kind ?? null,
    inputs: turn.items.flatMap(item => item.kind === 'message' && item.role === 'user' ? [{ id: item.id, text: item.text }] : []),
    latest_reply: [...turn.items].reverse().flatMap(item => item.kind === 'message' && item.role === 'assistant'
      ? [{ id: item.id, text: item.text, at: item.at ?? null }] : []).at(0) ?? null };
}
