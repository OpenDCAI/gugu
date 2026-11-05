import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract';
import { projectOwnerNotifications } from '@gugu/session-core/session-record/owner-notifications';

/** Keep the page cache raw: projecting individual pages would retain a detached notice after its source arrives. */
export function mergeNativeRecordPage(previous: NativeSessionRecord | null, page: NativeSessionRecord, mode: 'poll' | 'older' | 'newer' | 'tail', tail: boolean): NativeSessionRecord {
  if (!previous || tail || (previous.nativeOwnerNotificationEpoch ?? 0) !== (page.nativeOwnerNotificationEpoch ?? 0)) return page;
  const merged = new Map(previous.turns.filter(turn => turn.seq <= page.latestStoredSeq).map(turn => [turn.id, turn]));
  for (const turn of page.turns) merged.set(turn.id, turn);
  const next = { ...page, turns: [...merged.values()].sort((a, b) => a.seq - b.seq),
    hasNewer: mode === 'older' ? previous.hasNewer : page.hasNewer,
    activeTurn: mode === 'older' ? previous.activeTurn : page.activeTurn,
    nextCursor: mode === 'older' || !previous.turns.length ? page.nextCursor : previous.nextCursor };
  const origins = new Map(previous.turns.map((turn, index) => [turn.id, previous.originTurnIds[index] ?? turn.id]));
  page.turns.forEach((turn, index) => origins.set(turn.id, page.originTurnIds[index] ?? turn.id));
  next.originTurnIds = next.turns.map(turn => origins.get(turn.id)!);
  return next;
}

export function projectNativeRecord(record: NativeSessionRecord | null): NativeSessionRecord | null {
  if (!record) return null;
  const origins = new Map(record.turns.map((turn, index) => [turn.id, record.originTurnIds[index] ?? turn.id]));
  const shown = projectOwnerNotifications(record.turns, record.activeTurn, origins);
  return { ...record, ...shown, originTurnIds: shown.turns.map(turn => origins.get(turn.id)!) };
}
