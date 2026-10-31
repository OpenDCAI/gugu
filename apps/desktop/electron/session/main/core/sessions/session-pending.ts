import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { Receipt, Seq, SerializedError } from '@gugu/core/local/session-life/types';
import { db } from '@main/db/client';
import { messages, sessionPending, sessionPendingSource, sessions } from '@main/db/schema';
import type { LifeStore } from './session-life';
import type { PendingRow, PendingSource, PendingTurn } from './session-life-adapter';

interface PendingMetadata {
  kind: string;
  delivery?: PendingRow['message']['delivery'];
  sources?: PendingSource[];
  turn?: PendingTurn;
}

export interface EnqueuePending {
  readonly sessionId: string;
  readonly messageId: string;
  readonly text: string;
  readonly kind: PendingRow['kind'];
  readonly delivery?: PendingRow['message']['delivery'];
  readonly sources?: readonly PendingSource[];
  readonly turn?: PendingTurn;
}

function metadata(raw: string | null): PendingMetadata {
  return raw ? JSON.parse(raw) as PendingMetadata : { kind: 'ordinary-message' };
}

function pendingRow(row: { pending: typeof sessionPending.$inferSelect; message: typeof messages.$inferSelect }): PendingRow {
  const meta = metadata(row.message.metadata);
  return { seq: row.pending.seq as Seq, sessionId: row.pending.sessionId, kind: row.pending.kind, state: row.pending.state,
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
    const existing = tx.select().from(sessionPending)
      .where(and(eq(sessionPending.sessionId, input.sessionId), eq(sessionPending.messageId, input.messageId))).get();
    if (existing) return { inserted: false, seq: existing.seq as Seq, state: existing.state };
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
        return { inserted: false, seq: owner.seq as Seq, state: owner.state };
      }
    }
    const existingMessage = tx.select().from(messages).where(eq(messages.id, input.messageId)).get();
    if (existingMessage && (existingMessage.sessionId !== input.sessionId || existingMessage.content !== input.text || existingMessage.sender !== 'user')) {
      throw new Error(`Message ${input.messageId} conflicts with its persisted content`);
    }
    if (!existingMessage) tx.insert(messages).values({ id: input.messageId, sessionId: input.sessionId, content: input.text, sender: 'user',
      metadata: JSON.stringify({ kind: input.kind === 'ordinary' ? 'ordinary-message' : input.kind,
        ...(input.delivery ? { delivery: input.delivery } : {}), ...(input.sources ? { sources: input.sources } : {}),
        ...(input.turn ? { turn: input.turn } : {}) }) }).run();
    const pending = tx.insert(sessionPending).values({ sessionId: input.sessionId, messageId: input.messageId, kind: input.kind, state: 'queued' }).returning().get();
    for (const source of input.sources ?? []) tx.insert(sessionPendingSource).values({ seq: pending.seq, sessionId: input.sessionId, sourceMessageId: source.row.id }).run();
    return { inserted: true, seq: pending.seq as Seq, state: pending.state };
  });
}

/** The reader leaves out of a new batch every source this session's queue already holds (frozen batches never overlap). */
export function claimedSessionSources(sessionId: string, sourceMessageIds: readonly string[]): ReadonlySet<string> {
  if (!sourceMessageIds.length) return new Set();
  return new Set(db.select({ id: sessionPendingSource.sourceMessageId }).from(sessionPendingSource)
    .where(and(eq(sessionPendingSource.sessionId, sessionId), inArray(sessionPendingSource.sourceMessageId, [...sourceMessageIds]))).all().map(row => row.id));
}

/** Legs move into Life one by one (②: ACP). Other runtimes keep their own queue until their PR. */
export function lifeSessions(): readonly string[] {
  return db.select({ id: sessions.id }).from(sessions).where(eq(sessions.runtime, 'acp')).all().map(row => row.id);
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
  rows(sessionId) {
    return db.select({ pending: sessionPending, message: messages }).from(sessionPending).innerJoin(messages, eq(messages.id, sessionPending.messageId))
      .where(eq(sessionPending.sessionId, sessionId)).orderBy(asc(sessionPending.seq)).all().map(pendingRow);
  },
  commit(sessionId, effects) {
    db.transaction(tx => {
      for (const effect of effects) {
        if (effect.e === 'write-hold') tx.update(sessions).set({ lifeHold: effect.hold }).where(eq(sessions.id, sessionId)).run();
        if (effect.e === 'write-receipt') {
          const receipt = effect.receipt;
          const changed = tx.update(sessionPending).set({ state: receipt.state,
            attempt: receipt.state === 'dispatching' ? receipt.attempt : null,
            nativeReceiptId: receipt.state === 'accepted' ? receipt.nativeReceiptId : null,
            failure: receipt.state === 'failed' ? JSON.stringify(receipt.cause) : null,
            settledAt: receipt.state === 'failed' || receipt.state === 'unknown' ? new Date().toISOString() : null,
          }).where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.seq, effect.seq))).run();
          if (changed.changes !== 1) throw new Error(`Receipt ${effect.seq} has no pending row`);
        }
      }
    });
  },
  claim(sessionId) {
    db.update(sessionPending).set({ state: 'unknown', attempt: null, settledAt: new Date().toISOString() })
      .where(and(eq(sessionPending.sessionId, sessionId), eq(sessionPending.state, 'dispatching'))).run();
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
  remove(sessionId) { db.delete(sessions).where(eq(sessions.id, sessionId)).run(); },
};
