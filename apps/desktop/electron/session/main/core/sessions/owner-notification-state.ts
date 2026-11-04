import { and, desc, eq, like } from 'drizzle-orm';
import { db, type AppDb } from '@main/db/client';
import { kv, sessions, sessionTurns } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

type Source = Pick<AppDb, 'select' | 'insert' | 'delete'>;
const headKey = (id: string) => `owner-notification-head:${id}`;
const epochKey = (id: string) => `owner-notification-epoch:${id}`;
export function ownerNotificationHead(id: string, source: Source = db): number | undefined {
  const row = source.select({ value: kv.value }).from(kv).where(eq(kv.key, headKey(id))).get();
  return row ? Number(row.value) : undefined;
}
export function ownerNotificationEpoch(id: string, source: Source = db): number {
  const row = source.select({ value: kv.value }).from(kv).where(eq(kv.key, epochKey(id))).get();
  return row ? Number(row.value) : 0;
}
export function setOwnerNotificationHead(id: string, seq: number, source: Source): void {
  source.insert(kv).values({ key: headKey(id), value: String(seq), updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: String(seq), updatedAt: Date.now() } }).run();
}
/** Reverts reuse record sequences. The epoch invalidates readers even when the next head has the same value. */
export function rewindOwnerNotificationState(id: string, source: Source): void {
  const tail = source.select({ seq: sessionTurns.seq }).from(sessionTurns).where(and(eq(sessionTurns.sessionId, id), like(sessionTurns.turnId, 'owner-notify:%'))).orderBy(desc(sessionTurns.seq)).limit(1).get();
  if (tail) setOwnerNotificationHead(id, tail.seq, source);
  else source.delete(kv).where(eq(kv.key, headKey(id))).run();
  const epoch = ownerNotificationEpoch(id, source) + 1;
  source.insert(kv).values({ key: epochKey(id), value: String(epoch), updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: String(epoch), updatedAt: Date.now() } }).run();
}
export function publishOwnerNotificationState(id: string): void {
  const row = db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, id)).get();
  if (row) events.emit(sessionChangedChannel, { sessionId: id, projectId: row.projectId, changes: { nativeOwnerNotificationSeq: true, nativeOwnerNotificationEpoch: true } });
}
