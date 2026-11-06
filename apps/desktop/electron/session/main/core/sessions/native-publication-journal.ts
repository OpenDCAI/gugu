import { randomUUID } from 'node:crypto';
import { eq, like } from 'drizzle-orm';
import { db, type AppDb } from '@main/db/client';
import { kv, sessions } from '@main/db/schema';

export type NativePublicationContext = { ownerUserId: string; deviceId: string; agentUserId?: string };
export type NativePublication = NativePublicationContext & {
  id: string; order: number; sessionId: string; projectId: string; occurredAt: string; chatId?: string;
  ack?: { accountRevision: string; already: boolean };
};
export type PublicationDb = Pick<AppDb, 'select' | 'insert'>;
const PREFIX = 'native-personal-publication:';
const inputKey = (sessionId: string, inputId: string) => `native-personal-input:${JSON.stringify([sessionId, inputId])}`;
const listeners = new Set<() => void>();

export function readPublicationValue<T>(key: string, source: PublicationDb): T | undefined {
  const row = source.select({ value: kv.value }).from(kv).where(eq(kv.key, key)).get();
  return row ? JSON.parse(row.value) as T : undefined;
}

export function writePublicationValue(key: string, value: unknown, source: PublicationDb): void {
  const record = { key, value: JSON.stringify(value), updatedAt: Date.now() };
  source.insert(kv).values(record).onConflictDoUpdate({ target: kv.key, set: record }).run();
}

/** The caller writes this beside the actual input/transcript admission, in the same SQLite transaction. */
export function queueNativePublication(context: NativePublicationContext, sessionId: string, occurredAt: string, source: PublicationDb): NativePublication {
  if (!context.ownerUserId || !context.deviceId || !Number.isFinite(Date.parse(occurredAt))) throw new Error('Invalid native publication admission');
  const session = source.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!session) throw new Error(`Native publication session is missing: ${sessionId}`);
  const order = (readPublicationValue<number>('native-personal-publication-order', source) ?? 0) + 1;
  if (!Number.isSafeInteger(order)) throw new Error('Native publication admission order is exhausted');
  const entry: NativePublication = { ...context, id: randomUUID(), order, sessionId, projectId: session.projectId, occurredAt };
  writePublicationValue('native-personal-publication-order', order, source);
  writePublicationValue(PREFIX + entry.id, entry, source);
  // Runs after the synchronous transaction exits. A rollback leaves no item for the host to send.
  queueMicrotask(() => { for (const listener of listeners) listener(); });
  return entry;
}

export function nativeInputPublication(sessionId: string, inputId: string, source: PublicationDb = db): NativePublication | undefined {
  const id = readPublicationValue<string>(inputKey(sessionId, inputId), source);
  if (!id) return undefined;
  const entry = readPublicationValue<NativePublication>(PREFIX + id, source);
  if (!entry) throw new Error('Native input publication receipt is missing');
  return entry;
}

/** The input's stable admission ID is an alias, not a freshly generated ID at transcript settlement. */
export function queueNativeInput(context: NativePublicationContext, sessionId: string, inputId: string, at: string, source: PublicationDb): NativePublication {
  const before = nativeInputPublication(sessionId, inputId, source);
  if (before) {
    if (before.ownerUserId !== context.ownerUserId || before.deviceId !== context.deviceId) throw new Error('Native input publication owner changed');
    return before;
  }
  const entry = queueNativePublication(context, sessionId, at, source);
  writePublicationValue(inputKey(sessionId, inputId), entry.id, source);
  return entry;
}

export function pendingNativePublications(source: PublicationDb = db): NativePublication[] {
  return source.select({ value: kv.value }).from(kv).where(like(kv.key, PREFIX + '%')).all()
    .map(row => JSON.parse(row.value) as NativePublication).filter(entry => !entry.ack).sort((a, b) => a.order - b.order);
}

export function saveNativePublication(entry: NativePublication, source: PublicationDb = db): void {
  const before = readPublicationValue<NativePublication>(PREFIX + entry.id, source);
  if (!before || before.ownerUserId !== entry.ownerUserId || before.deviceId !== entry.deviceId
    || before.sessionId !== entry.sessionId || before.occurredAt !== entry.occurredAt
    || before.agentUserId && before.agentUserId !== entry.agentUserId || before.chatId && before.chatId !== entry.chatId) {
    throw new Error('Native publication identity changed');
  }
  writePublicationValue(PREFIX + entry.id, entry, source);
}

export function onNativePublicationQueued(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
