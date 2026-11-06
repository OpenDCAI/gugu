import { eq } from 'drizzle-orm';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { addNativeReplies, nativeMessageKey, nativeReadAliases, nativeReplyKeys, seeNativeReplies, unreadNativeMessages, unreadOwnerNotifications, type NativeReadJournal } from '@gugu/session-core/session-record/native-read';
import { db, type AppDb } from '@main/db/client';
import { kv, sessions } from '@main/db/schema';
import { events } from '@main/lib/events';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';
import { personalConversationMessages, noteNativeConversationActivity, truncateNativeConversationActivity } from './session-conversation-activity';

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
export function nativeOwnerNotificationUnread(sessionId: string): string[] { return unreadOwnerNotifications(read(sessionId)); }

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

export function publishConversationActivity(sessionId: string): void {
  const session = db.select({ projectId: sessions.projectId }).from(sessions).where(eq(sessions.id, sessionId)).get();
  if (session) events.emit(sessionChangedChannel, { sessionId, projectId: session.projectId, changes: { nativeLastMessage: true } });
}

/** Historical imports repair the preview only; they do not create unread/live-message side effects. */
export function noteNativeConversationHistory(sessionId: string, turn: TranscriptTurn, transaction?: JournalDb): (() => void) | undefined {
  return noteNativeConversationActivity(sessionId, turn, transaction ?? db) ? () => publishConversationActivity(sessionId) : undefined;
}

/** Delivery-envelope conversations retain IM read ownership. Raw personal inputs use the native journal. */
export function noteNativeConversationReplies(sessionId: string, turn: TranscriptTurn, live: TranscriptTurn = turn, transaction?: JournalDb): (() => void) | undefined {
  const messages = personalConversationMessages(turn);
  if (!messages.length) return undefined;
  const activity = noteNativeConversationActivity(sessionId, turn, transaction ?? db);
  const personal = new Set(messages.filter(item => item.role === 'assistant').map(item => item.id));
  const keys = nativeReplyKeys(turn).filter(id => personal.has(id));
  const aliases = new Map(turn.items.flatMap((item, index) => item.kind === 'message' && live.items[index]?.kind === 'message' ? [[item.id, nativeMessageKey(live.items[index]!.id)]] : []));
  const notifications = new Set(turn.items.flatMap(item => item.kind === 'message' && item.ownerNotification ? [item.id] : []));
  const publish = keys.length ? update(sessionId, journal => addNativeReplies(journal, keys, aliases, notifications), transaction).publish : undefined;
  if (activity || publish) return () => {
    publish?.();
    if (activity) publishConversationActivity(sessionId);
  };
}
export function markNativeConversationVisible(sessionId: string, itemIds: readonly string[]): string[] {
  if (itemIds.length > 500) throw new Error('Too many visible conversation messages');
  return update(sessionId, journal => seeNativeReplies(journal, itemIds)).unread;
}

export function truncateNativeConversationRead(sessionId: string, fromSeq: number, transaction?: JournalDb, removed: ReadonlySet<number> = new Set()): (() => void) | undefined {
  const activity = truncateNativeConversationActivity(sessionId, fromSeq, transaction ?? db, removed);
  const prefix = `${sessionId}:turn:s`;
  const publish = update(sessionId, journal => Object.fromEntries(Object.entries(journal).filter(([key]) => {
    const seq = key.startsWith(prefix) ? /^(\d+):/.exec(key.slice(prefix.length))?.[1] : undefined;
    return seq === undefined || (Number(seq) < fromSeq && !removed.has(Number(seq)));
  })), transaction).publish;
  return () => { publish(); if (activity) publishConversationActivity(sessionId); };
}
