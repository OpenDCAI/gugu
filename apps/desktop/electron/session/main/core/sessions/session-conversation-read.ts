import { eq } from 'drizzle-orm';
import { isDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { addNativeReplies, nativeMessageKey, nativeReadAliases, nativeReplyKeys, seeNativeReplies, unreadNativeMessages, type NativeReadJournal } from '@gugu/session-core/session-record/native-read';
import { db, type AppDb } from '@main/db/client';
import { kv, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { isPersonalConversationTurn, noteNativeConversationActivity, truncateNativeConversationActivity } from './session-conversation-activity';

type JournalDb = Pick<AppDb, 'select' | 'insert'>;
const keyFor = (sessionId: string) => `native-conversation-read:${sessionId}`;
function read(sessionId: string, source: JournalDb = db): NativeReadJournal {
  const record = source.select({ value: kv.value }).from(kv).where(eq(kv.key, keyFor(sessionId))).get();
  if (!record) return {};
  const journal: unknown = JSON.parse(record.value);
  if (!journal || typeof journal !== 'object' || Array.isArray(journal) || Object.values(journal).some(value => !value || typeof value.read !== 'boolean' || !Array.isArray(value.aliases) || value.aliases.some((id: unknown) => typeof id !== 'string'))) {
    throw new Error(`Invalid native conversation read journal: ${sessionId}`);
  }
  return journal as NativeReadJournal;
}
export function nativeConversationAliases(sessionId: string): Record<string, string> { return nativeReadAliases(read(sessionId)); }
export function nativeConversationUnread(sessionId: string): string[] { return unreadNativeMessages(read(sessionId)); }

function update(sessionId: string, change: (journal: NativeReadJournal) => NativeReadJournal, transaction?: JournalDb): { unread: string[]; publish: () => void } {
  const write = (tx: JournalDb) => {
    const session = tx.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const before = read(sessionId, tx);
    const journal = change(before);
    const value = JSON.stringify(journal);
    const dirty = value !== JSON.stringify(before);
    if (dirty) tx.insert(kv).values({ key: keyFor(sessionId), value, updatedAt: Date.now() })
      .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: Date.now() } }).run();
    return { projectId: session.projectId, unread: unreadNativeMessages(journal), dirty };
  };
  const result = transaction ? write(transaction) : db.transaction(write);
  const publish = () => {
    if (result.dirty) events.emit(sessionChangedChannel, { sessionId, projectId: result.projectId, changes: { nativeUnreadKeys: true } });
  };
  if (!transaction) publish();
  return { unread: result.unread, publish };
}

function publishActivity(sessionId: string): void {
  const session = db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (session) events.emit(sessionChangedChannel, { sessionId, projectId: session.projectId, changes: { nativeLastMessage: true } });
}

/** Delivery-envelope conversations retain IM read ownership. Raw personal inputs use the native journal. */
export function noteNativeConversationReplies(sessionId: string, turn: TranscriptTurn, live: TranscriptTurn = turn, transaction?: JournalDb): (() => void) | undefined {
  if (!isPersonalConversationTurn(turn)) return undefined;
  const activity = noteNativeConversationActivity(sessionId, turn, transaction ?? db);
  let nativeInput = true;
  const personal = new Set<string>();
  for (const item of turn.items) {
    if (item.kind !== 'message') continue;
    if (item.role === 'user') nativeInput = !isDeliveryEnvelope(item.text);
    else if (item.role === 'assistant' && nativeInput) personal.add(item.id);
  }
  const keys = nativeReplyKeys(turn).filter(id => personal.has(id));
  const aliases = new Map(turn.items.flatMap((item, index) => item.kind === 'message' && live.items[index]?.kind === 'message' ? [[item.id, nativeMessageKey(live.items[index]!.id)]] : []));
  const publish = keys.length ? update(sessionId, journal => addNativeReplies(journal, keys, aliases), transaction).publish : undefined;
  if (activity || publish) return () => {
    publish?.();
    if (activity) publishActivity(sessionId);
  };
}
export function markNativeConversationVisible(sessionId: string, itemIds: readonly string[]): string[] {
  if (itemIds.length > 500) throw new Error('Too many visible conversation messages');
  return update(sessionId, journal => seeNativeReplies(journal, itemIds)).unread;
}

export function truncateNativeConversationRead(sessionId: string, fromSeq: number, transaction?: JournalDb): (() => void) | undefined {
  const activity = truncateNativeConversationActivity(sessionId, fromSeq, transaction ?? db);
  const prefix = `${sessionId}:turn:s`;
  const publish = update(sessionId, journal => Object.fromEntries(Object.entries(journal).filter(([key]) => {
    const seq = key.startsWith(prefix) ? /^(\d+):/.exec(key.slice(prefix.length))?.[1] : undefined;
    return seq === undefined || Number(seq) < fromSeq;
  })), transaction).publish;
  return () => { publish(); if (activity) publishActivity(sessionId); };
}
