import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessionTurns } from '@main/db/schema';

const filling = new Map<string, number>();

/** The first replay row decides the whole batch, before any backfill changes the count. */
export function mayFillReplay(sessionId: string, seq: number, stored: number): boolean {
  if (seq === 0) {
    filling.delete(sessionId);
    if (stored === 0) filling.set(sessionId, 0);
  }
  return filling.get(sessionId) === seq && stored === seq;
}
export function didFillReplay(sessionId: string, seq: number): void { filling.set(sessionId, seq + 1); }
export function stopFillingReplay(sessionId: string): void { filling.delete(sessionId); }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Old rows lack provenance. Recover only complete UUID-anchored user/answer pairs, never counters or text. */
function messageIdentity(turn: TranscriptTurn): string | null {
  const prefix = `${turn.id}:message:`;
  const messages = turn.items.filter(item => item.kind === 'message');
  if (!messages.some(item => item.role === 'user') || !messages.some(item => item.role === 'assistant')) return null;
  const keys = messages.map(item => item.id.startsWith(prefix) && UUID.test(item.id.slice(prefix.length)) ? `${item.role}:${item.id.slice(prefix.length)}` : null);
  return keys.every(Boolean) ? JSON.stringify(keys) : null;
}

function replayOnly(turn: TranscriptTurn): boolean {
  return turn.startedAt === undefined && turn.endedAt === undefined && !turn.outcome
    && turn.items.length > 0 && turn.items.every(item => item.kind === 'message');
}

export type StoredReplayRow = { seq: number; data: string; turnId: string };

/** One visible-row projection for transcript paging and derived search; source rows stay unchanged. */
export function filterReadableStoredRows<T extends StoredReplayRow>(parsed: (T & { turn: TranscriptTurn })[], previous: TranscriptTurn | null) {
  return parsed.filter(row => {
    const candidate = replayOnly(row.turn) ? messageIdentity(row.turn) : null;
    if (candidate && previous && candidate === messageIdentity(previous)) return false;
    if (row.turn.outcome && row.turn.startedAt !== undefined) previous = row.turn;
    return true;
  });
}

/** View repair only: leave archived rows, sequence numbers and message contents unchanged. */
export async function readableStoredRows(sessionId: string, rows: StoredReplayRow[]) {
  let previous: TranscriptTurn | null = null;
  const parsed = rows.map(row => ({ ...row, turn: JSON.parse(row.data) as TranscriptTurn }));
  const first = parsed[0];
  // Carry the same preceding settled context across any page boundary, including a leading unfinished row.
  if (first && !(first.turn.outcome && first.turn.startedAt !== undefined)) {
    const [row] = await db.select({ data: sessionTurns.data }).from(sessionTurns).where(and(
      eq(sessionTurns.sessionId, sessionId), lt(sessionTurns.seq, first.seq),
      sql`json_extract(${sessionTurns.data}, '$.outcome.kind') IS NOT NULL`,
      sql`json_extract(${sessionTurns.data}, '$.startedAt') IS NOT NULL`,
    )).orderBy(desc(sessionTurns.seq)).limit(1);
    previous = row ? JSON.parse(row.data) as TranscriptTurn : null;
  }
  return filterReadableStoredRows(parsed, previous);
}
