import { randomUUID } from 'node:crypto';
import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Receipt, Seq, SerializedError } from '@gugu/core/local/session-life/types';
import { db } from '@main/db/client';
import { messages, sessionPending, sessionPendingSource, sessions } from '@main/db/schema';
import type { LifeStore } from './session-life';
import type { PendingRow, PendingSource, PendingTurn } from './session-life-adapter';
import { queueNativeInput, type NativePublicationContext } from './native-publication-journal';

interface PendingMetadata {
  kind: string;
  delivery?: PendingRow['message']['delivery'];
  sources?: PendingSource[];
  turn?: PendingTurn;
}

interface PendingInput {
  readonly sessionId: string;
  readonly text: string;
  readonly delivery?: PendingRow['message']['delivery'];
  readonly sources?: readonly PendingSource[];
  readonly turn?: PendingTurn;
  /** A rejected inbox item is durable and visible, but must never enter provider admission. */
  readonly failure?: SerializedError;
  readonly personalPublication?: NativePublicationContext;
}
export type EnqueuePending = PendingInput & (
  | { readonly kind: 'inbox-batch'; readonly sources: readonly PendingSource[]; readonly messageId?: never }
  | { readonly kind: 'ordinary' | 'session-direct'; readonly messageId: string }
);

function metadata(raw: string | null): PendingMetadata {
  return raw ? JSON.parse(raw) as PendingMetadata : { kind: 'ordinary-message' };
}

function pendingRow(row: { pending: typeof sessionPending.$inferSelect; message: typeof messages.$inferSelect }): PendingRow {
  const meta = metadata(row.message.metadata);
  return { seq: row.pending.seq as Seq, sessionId: row.pending.sessionId, sentAt: Date.parse(row.pending.enqueuedAt.includes('T') ? row.pending.enqueuedAt : `${row.pending.enqueuedAt.replace(' ', 'T')}Z`), // SQLite's default is UTC without a zone (rows the migration moved)
      kind: row.pending.kind, state: row.pending.state,
    failure: row.pending.failure ? JSON.parse(row.pending.failure) as SerializedError : null,
    message: { id: row.message.id, text: row.message.content,
      ...(row.pending.kind === 'session-direct' ? { kind: 'session-direct' as const } : {}),
      ...(meta.delivery ? { delivery: meta.delivery } : {}) }, sources: meta.sources ?? [], turn: meta.turn ?? { kind: 'prompt' } };
}

export function readPending(sessionId: string, seq: Seq): PendingRow {
  const row = db.select({ pending: sessionPending, message: messages }).from(sessionPending)
    .innerJoin(messages, eq(messages.id, sessionPending.messageId))
    .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.seq, seq))).get();
  if (!row) throw new Error(`Pending message ${seq} does not belong to session ${sessionId}`);
  return pendingRow(row);
}

/** Insert the body, queue row and frozen source membership in one transaction. */
export function enqueuePending(input: EnqueuePending): { inserted: boolean; seq: Seq; state: Receipt['state'] } {
  return db.transaction(tx => {
    if (input.kind !== 'inbox-batch') {
      const existing = tx.select({ pending: sessionPending, message: messages }).from(sessionPending).innerJoin(messages, eq(messages.id, sessionPending.messageId))
        .where(and(eq(sessionPending.sessionId, input.sessionId), eq(sessionPending.messageId, input.messageId))).get();
      if (existing) {
        if (existing.message.content !== input.text || existing.message.sender !== 'user') throw new Error(`Message ${input.messageId} conflicts with its persisted content`);
        return { inserted: false, seq: existing.pending.seq as Seq, state: existing.pending.state };
      }
    }
    const ids = input.sources?.map(source => source.row.id) ?? [];
    if (ids.length !== new Set(ids).size) throw new Error('An inbox batch repeats a source message');
    if (ids.length) {
      const claimed = tx.select({ seq: sessionPendingSource.seq }).from(sessionPendingSource)
        .where(and(eq(sessionPendingSource.sessionId, input.sessionId), inArray(sessionPendingSource.sourceMessageId, ids))).all();
      if (claimed.length) {
        // A batch is frozen at enqueue: only the exact same member set is a duplicate (the reader's refetch).
        // Any other overlap, a subset included, is a caller bug: the reader must leave claimed sources out.
        const seqs = new Set(claimed.map(row => row.seq));
        const members = seqs.size === 1 ? tx.select({ id: sessionPendingSource.sourceMessageId }).from(sessionPendingSource)
          .where(eq(sessionPendingSource.seq, claimed[0]!.seq)).all().length : -1;
        if (claimed.length !== ids.length || members !== ids.length) throw new Error(`Inbox batch overlaps claimed sources for session ${input.sessionId}`);
        const owner = tx.select().from(sessionPending).where(eq(sessionPending.seq, claimed[0]!.seq)).get();
        if (!owner) throw new Error('Source membership has no pending owner');
        const body = tx.select().from(messages).where(eq(messages.id, owner.messageId)).get();
        const frozen = metadata(body?.metadata ?? null).sources ?? [];
        if ((input.sources ?? []).some(source => frozen.find(member => member.row.id === source.row.id)?.row.content !== source.row.content)) {
          throw new Error(`Inbox source for session ${input.sessionId} conflicts with its persisted content`);
        }
        return { inserted: false, seq: owner.seq as Seq, state: owner.state };
      }
    }
    // Inbox identity belongs to (recipient session, source messages), above. A cloud ID is never a local row ID.
    const messageId = input.kind === 'inbox-batch' ? randomUUID() : input.messageId;
    const existingMessage = tx.select().from(messages).where(eq(messages.id, messageId)).get();
    if (existingMessage && (existingMessage.sessionId !== input.sessionId || existingMessage.content !== input.text || existingMessage.sender !== 'user')) {
      throw new Error(`Message ${input.messageId} conflicts with its persisted content`);
    }
    if (!existingMessage) tx.insert(messages).values({ id: messageId, sessionId: input.sessionId, content: input.text, sender: 'user',
      metadata: JSON.stringify({ kind: input.kind === 'ordinary' ? 'ordinary-message' : input.kind,
        ...(input.delivery ? { delivery: input.delivery } : {}), ...(input.sources ? { sources: input.sources } : {}),
        ...(input.turn ? { turn: input.turn } : {}) }) }).run();
    const pending = tx.insert(sessionPending).values({ sessionId: input.sessionId, messageId, kind: input.kind,
      state: input.failure ? 'failed' : 'queued', failure: input.failure ? JSON.stringify(input.failure) : null,
      settledAt: input.failure ? new Date().toISOString() : null, enqueuedAt: new Date().toISOString() }).returning().get();
    for (const source of input.sources ?? []) tx.insert(sessionPendingSource).values({ seq: pending.seq, sessionId: input.sessionId, sourceMessageId: source.row.id }).run();
    if (input.personalPublication && input.kind === 'ordinary' && !input.failure) queueNativeInput(input.personalPublication, input.sessionId, messageId, pending.enqueuedAt, tx);
    return { inserted: true, seq: pending.seq as Seq, state: pending.state };
  }, { behavior: 'immediate' });
}

/**
 * The sources this session's queue already holds, with whether their row is still open (queued / dispatching). The reader
 * leaves every one out of a new batch (frozen batches never overlap), including terminal failures without read receipts.
 * An accepted row whose read marker has not landed is not held back: the reader's refetch of it is the exact duplicate
 * `enqueue` answers by retrying that read marker.
 */
export function claimedSessionSources(sessionId: string, sourceMessageIds: readonly string[]): ReadonlyMap<string, boolean> {
  if (!sourceMessageIds.length) return new Map();
  return new Map(db.select({ id: sessionPendingSource.sourceMessageId, state: sessionPending.state, settledAt: sessionPending.settledAt })
    .from(sessionPendingSource).innerJoin(sessionPending, eq(sessionPending.seq, sessionPendingSource.seq))
    .where(and(eq(sessionPendingSource.sessionId, sessionId), inArray(sessionPendingSource.sourceMessageId, [...sourceMessageIds]))).all()
    .filter(row => row.state !== 'accepted' || row.settledAt !== null)
    .map(row => [row.id, row.state === 'queued' || row.state === 'dispatching']));
}

/** Legs move into Life one by one (②: ACP). Other runtimes keep their own queue until their PR. */
export function lifeSessions(): readonly string[] {
  return db.select({ id: sessions.id }).from(sessions).where(eq(sessions.runtime, 'acp')).all().map(row => row.id);
}

/** Whether session-life owns this session (a missing row is not one). */
export function isLifeSession(sessionId: string): boolean {
  return db.select({ runtime: sessions.runtime }).from(sessions).where(eq(sessions.id, sessionId)).get()?.runtime === 'acp';
}

export const lifeStore: LifeStore = {
  read(sessionId) {
    const row = db.select({ archivedAt: sessions.archivedAt, hold: sessions.lifeHold }).from(sessions).where(eq(sessions.id, sessionId)).get();
    if (!row) throw new Error(`Session ${sessionId} not found`);
    return { archived: row.archivedAt !== null, hold: row.hold };
  },
  pending(sessionId) {
    const rows = db.select({ seq: sessionPending.seq, state: sessionPending.state }).from(sessionPending)
      .where(and(eq(sessionPending.sessionId, sessionId), inArray(sessionPending.state, ['queued', 'dispatching']))).orderBy(asc(sessionPending.seq)).all();
    return { queued: rows.filter(row => row.state === 'queued').map(row => row.seq as Seq),
      dispatching: rows.filter(row => row.state === 'dispatching').map(row => row.seq as Seq) };
  },
  row: readPending,
  enqueue: enqueuePending,
  unaccepted(sessionId) {
    return db.select({ pending: sessionPending, message: messages }).from(sessionPending).innerJoin(messages, eq(messages.id, sessionPending.messageId))
      .where(and(eq(sessionPending.sessionId, sessionId), inArray(sessionPending.state, ['queued', 'dispatching', 'failed', 'unknown'])))
      .orderBy(asc(sessionPending.seq)).all().map(pendingRow);
  },
  commit(sessionId, effects) {
    db.transaction(tx => {
      for (const effect of effects) {
        if (effect.e === 'write-hold') tx.update(sessions).set({ lifeHold: effect.hold }).where(eq(sessions.id, sessionId)).run();
        if (effect.e === 'delete-row') {
          const pending = tx.select({ messageId: sessionPending.messageId }).from(sessionPending)
            .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.seq, effect.seq))).get();
          if (!pending) throw new Error(`Discard ${effect.seq} has no pending row`);
          // The message goes, and its row with it (foreign key): nothing is left to draw or send.
          tx.delete(messages).where(eq(messages.id, pending.messageId)).run();
          // Creation turns are all queued together and re-admitted from this list while it stands: a discarded one must not come back.
          const row = tx.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).get();
          if (row?.config?.type === 'acp' && row.config.initialQueue) {
            const { initialQueue: _gone, ...config } = row.config;
            tx.update(sessions).set({ config }).where(eq(sessions.id, sessionId)).run();
          }
        }
        if (effect.e === 'write-receipt') {
          const receipt = effect.receipt;
          const changed = tx.update(sessionPending).set({ state: receipt.state,
            attempt: receipt.state === 'dispatching' ? receipt.attempt : null,
            nativeReceiptId: receipt.state === 'accepted' ? receipt.nativeReceiptId : null,
            // A dispatching row keeps the loss it went back to the queue with (#552: its second loss fails it).
            ...(receipt.state === 'dispatching' ? {} : { failure: receipt.state === 'failed' ? JSON.stringify(receipt.cause)
              : receipt.state === 'queued' && receipt.channelLost ? JSON.stringify(receipt.channelLost) : null }),
            settledAt: receipt.state === 'failed' || receipt.state === 'unknown' ? new Date().toISOString() : null,
          }).where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.seq, effect.seq))).run();
          if (changed.changes !== 1) throw new Error(`Receipt ${effect.seq} has no pending row`);
        }
      }
    }, { behavior: 'immediate' });
  },
  claim(sessionId) {
    return db.update(sessionPending).set({ state: 'unknown', attempt: null, settledAt: new Date().toISOString() })
      .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.state, 'dispatching')))
      .returning({ seq: sessionPending.seq }).all().map(row => row.seq as Seq);
  },
  acceptedUnsettled(sessionId) {
    return db.select({ seq: sessionPending.seq }).from(sessionPending)
      .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.state, 'accepted'), isNull(sessionPending.settledAt)))
      .orderBy(asc(sessionPending.seq)).all().map(row => row.seq as Seq);
  },
  settleRead(sessionId, seq) {
    db.update(sessionPending).set({ settledAt: new Date().toISOString() })
      .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.seq, seq), eq(sessionPending.state, 'accepted'))).run();
  },
  // Only a side chat (memory store) is ever removed: a persisted task is archived, never deleted.
  remove(sessionId) { throw new Error(`Session ${sessionId} is a task; it is archived, never removed`); },
};
