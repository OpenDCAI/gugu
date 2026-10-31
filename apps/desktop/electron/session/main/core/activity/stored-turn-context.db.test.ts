import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, sqlite: undefined as Database.Database | undefined }));
vi.mock('@main/db/client', () => ({ get db() { return mocks.db; }, get sqlite() { return mocks.sqlite; } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: () => () => {} } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
import { installActivityCollector, activityJournal } from './collector';
import { runActivityAction } from './actions';
import { persistCommittedTurn, readStoredTurns, truncateStoredHistory } from '../sessions/session-turn-store';

/**
 * The activity index names a turn by the session's stored history sequence, assigned by the one writer of that
 * history. The runtime's own turn ids restart at 0 with every run (and live-only turns such as session notices shift
 * them against the provider record), so they cannot name a turn across runs or sources.
 */
let fixture: Awaited<ReturnType<typeof openFixture>>;
let stop: () => void;
let home: string;
beforeEach(async () => {
  fixture = await openFixture('empty');
  mocks.db = fixture.db;
  mocks.sqlite = fixture.sqlite;
  fixture.sqlite.exec(`INSERT INTO projects (id, name, path) VALUES ('p1', 'P', '/repo');
    INSERT INTO sessions (id, project_id, title) VALUES ('c1', 'p1', 'C');`);
  home = mkdtempSync(join(tmpdir(), 'gugu-activity-turns-')); vi.stubEnv('GUGU_HOME', home);
  stop = installActivityCollector();
});
afterEach(() => { stop?.(); fixture?.close(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

function turn(runtimeId: string, text: string, reply: string): TranscriptTurn {
  return { id: runtimeId, seq: 0, initiator: 'user', startedAt: 1, endedAt: 2, outcome: { kind: 'done', reason: 'end_turn' },
    items: [{ kind: 'message', id: `${runtimeId}:in`, seq: 0, role: 'user', text },
      { kind: 'message', id: `${runtimeId}:out`, seq: 1, role: 'assistant', text: reply }] } as TranscriptTurn;
}
const turnEvents = () => activityJournal().list({ since: '1970-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' }).events
  .filter((event) => event.kind === 'session.turn_recorded');
const context = async (eventId: string) =>
  runActivityAction({ action: 'activity_context', event_id: eventId }) as Promise<Record<string, unknown> & {
    context?: Array<{ inputs: Array<{ text: string }> }> }>;

describe('turn events name the stored turn', () => {
  it('resolves each run\'s turn although both runs gave it the same runtime turn id', async () => {
    // Two runs of the session: the runtime numbered both turns c1:turn:0.
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', 'first run', 'one') });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', 'second run', 'two') });
    expect((await readStoredTurns('c1')).originTurnIds).toEqual(['c1:turn:0', 'c1:turn:0']);

    const [first, second] = turnEvents();
    expect([first?.turn_seq, second?.turn_seq]).toEqual([0, 1]);
    expect(await context(second!.event_id)).toMatchObject({ scope: 'event_turn', event_anchored: true, source: 'stored_history',
      context: [{ inputs: [{ text: 'second run' }], latest_reply: { text: 'two' } }], next_before_seq: 1 });
    expect(await context(first!.event_id)).toMatchObject({ context: [{ inputs: [{ text: 'first run' }] }], has_older: false });
    expect(await runActivityAction({ action: 'activity_context', event_id: second!.event_id, before_seq: 1 }))
      .toMatchObject({ scope: 'older_turns', source: 'stored_history', context: [{ inputs: [{ text: 'first run' }] }] });
  });

  it('reports a turn a revert removed instead of answering with the turn that took its sequence', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:0', 'kept', 'a') });
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:1', 'reverted', 'b') });
    await truncateStoredHistory('c1', 1);
    await persistCommittedTurn({ sessionId: 'c1', source: 'live', turn: turn('c1:turn:1', 'replacement', 'c') });

    const [kept, reverted, replacement] = turnEvents();
    expect([kept?.turn_seq, reverted?.turn_seq, replacement?.turn_seq]).toEqual([0, 1, 1]);
    expect(await context(reverted!.event_id)).toMatchObject({ context_available: false, reason: expect.stringMatching(/revert/) });
    expect(await context(replacement!.event_id)).toMatchObject({ context_available: true, context: [{ inputs: [{ text: 'replacement' }] }] });
    expect(await context(kept!.event_id)).toMatchObject({ context_available: true, context: [{ inputs: [{ text: 'kept' }] }] });
  });

  it('records only turns that happen now, not replayed history', async () => {
    await persistCommittedTurn({ sessionId: 'c1', source: 'replay', turn: turn('c1:turn:0', 'old history', 'x') });
    expect(turnEvents()).toEqual([]);
  });
});
