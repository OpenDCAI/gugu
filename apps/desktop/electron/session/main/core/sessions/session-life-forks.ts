import type { Hold, Receipt, Seq } from '@gugu/core/local/session-life/types';
import type { LifeStore } from './session-life';
import type { PendingRow } from './session-life-adapter';
import type { EnqueuePending } from './session-pending';

/**
 * A runtime fork (side chat) is a Life entry with no session row and no task-list presence: it lives in memory,
 * borrows its parent's identity and workspace, and ends with its parent. This module is its registry and its store
 * (the same LifeStore interface the database store implements).
 */
export interface RuntimeFork {
  readonly forkId: string;
  readonly parentId: string;
  /** The parent's native session the fork branches from. */
  readonly forkFromProviderSessionId: string;
}

interface ForkRecord {
  readonly fork: RuntimeFork;
  hold: Hold | null;
  readonly rows: Map<Seq, { row: PendingRow; readSettled: boolean }>;
}

const records = new Map<string, ForkRecord>();
let nextSeq = 0;

function record(forkId: string): ForkRecord {
  const found = records.get(forkId);
  if (!found) throw new Error(`Side chat ${forkId} is not open on this host`);
  return found;
}

function entry(forkId: string, seq: Seq): { row: PendingRow; readSettled: boolean } {
  const found = record(forkId).rows.get(seq);
  if (!found) throw new Error(`Pending message ${seq} does not belong to side chat ${forkId}`);
  return found;
}

function rowsOf(forkId: string): PendingRow[] {
  return [...record(forkId).rows.values()].map(value => value.row);
}

/** Open a side chat of `parentId`. Reopening the same fork of the same parent is the same entry. */
export function openRuntimeFork(fork: RuntimeFork): void {
  if (fork.forkId === fork.parentId) throw new Error(`Session ${fork.parentId} cannot be its own side chat`);
  const existing = records.get(fork.forkId);
  if (existing) {
    if (existing.fork.parentId !== fork.parentId || existing.fork.forkFromProviderSessionId !== fork.forkFromProviderSessionId) {
      throw new Error(`Side chat ${fork.forkId} is already open with another source`);
    }
    return;
  }
  records.set(fork.forkId, { fork, hold: null, rows: new Map() });
}

export function runtimeFork(forkId: string): RuntimeFork | null { return records.get(forkId)?.fork ?? null; }
export function runtimeForks(): readonly string[] { return [...records.keys()]; }
export function runtimeForksOf(parentId: string): readonly string[] {
  return [...records.values()].filter(value => value.fork.parentId === parentId).map(value => value.fork.forkId);
}

export const forkStore: LifeStore = {
  read(forkId) { return { archived: false, hold: record(forkId).hold }; },
  pending(forkId) {
    const rows = rowsOf(forkId);
    return { queued: rows.filter(row => row.state === 'queued').map(row => row.seq),
      dispatching: rows.filter(row => row.state === 'dispatching').map(row => row.seq) };
  },
  row: (forkId, seq) => entry(forkId, seq).row,
  unaccepted: forkId => rowsOf(forkId).filter(row => row.state !== 'accepted'),
  enqueue(input: EnqueuePending) {
    const fork = record(input.sessionId);
    // A side chat is typed into by its person only: no inbox batch, no session-direct envelope reaches it.
    if (input.kind !== 'ordinary' || input.sources?.length) throw new Error(`Side chat ${input.sessionId} only takes its person's input`);
    const existing = rowsOf(input.sessionId).find(row => row.message.id === input.messageId);
    if (existing) {
      if (existing.message.text !== input.text) throw new Error(`Message ${input.messageId} conflicts with its pending content`);
      return { inserted: false, seq: existing.seq, state: existing.state };
    }
    const seq = ++nextSeq as Seq;
    fork.rows.set(seq, { readSettled: false, row: { seq, sessionId: input.sessionId, kind: input.kind, state: 'queued', failure: null,
      message: { id: input.messageId, text: input.text, ...(input.delivery ? { delivery: input.delivery } : {}) },
      sources: [], turn: input.turn ?? { kind: 'prompt' } } });
    return { inserted: true, seq, state: 'queued' as const };
  },
  commit(forkId, effects) {
    const fork = record(forkId);
    for (const effect of effects) {
      if (effect.e === 'write-hold') fork.hold = effect.hold;
      if (effect.e === 'write-receipt') {
        const found = entry(forkId, effect.seq);
        const receipt: Receipt = effect.receipt;
        // A dispatching row keeps the loss it went back to the queue with (#552: its second loss fails it).
        found.row = { ...found.row, state: receipt.state, failure: receipt.state === 'dispatching' ? found.row.failure
          : receipt.state === 'failed' ? receipt.cause : receipt.state === 'queued' ? receipt.channelLost ?? null : null };
      }
    }
  },
  claim(forkId) {
    const claimed: Seq[] = [];
    for (const found of record(forkId).rows.values()) {
      if (found.row.state === 'dispatching') { found.row = { ...found.row, state: 'unknown' }; claimed.push(found.row.seq); }
    }
    return claimed;
  },
  acceptedUnsettled(forkId) {
    return [...record(forkId).rows.values()].filter(value => value.row.state === 'accepted' && !value.readSettled).map(value => value.row.seq);
  },
  settleRead(forkId, seq) { entry(forkId, seq).readSettled = true; },
  remove(forkId) { record(forkId); records.delete(forkId); },
};
