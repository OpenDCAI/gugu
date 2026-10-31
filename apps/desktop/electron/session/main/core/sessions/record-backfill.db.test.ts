import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { TranscriptTurn } from '@gugu/session-core/acp';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined,
  row: { runtime: 'pty', provider: 'codex', providerSessionId: 'record', agentStatus: 'idle' as string | null },
  turns: [] as TranscriptTurn[], complete: true, available: true, pick: vi.fn() }));
vi.mock('@main/db/client', () => ({ get db() { return state.db; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/session-timeline/service', () => ({
  readSessionRow: () => state.row,
  pickRecordTurns: state.pick,
}));
vi.mock('@main/core/session-timeline/locate', () => ({ sessionRecordHarnessForProvider: (provider: string) => provider }));
vi.mock('@main/core/session-timeline/write-bridge', () => ({ acpSessionLive: async () => false }));
vi.mock('./session-process', () => ({ sessionProcess: () => null }));

import { events } from '@main/lib/events';
import { onActivitySignal } from '../activity/signals';
import { sessionEvents } from './session-events';
import { syncStoredHistoryFromRecord } from './record-backfill';
import { withStoredTurns } from './session-turn-store';
import { nativeConversationUnread } from './session-conversation-read';

type Fixture = Awaited<ReturnType<typeof openFixture>>;
let fixture: Fixture;
const turn = (seq: number): TranscriptTurn => ({ id: `c1:turn:${seq}`, seq, initiator: 'user',
  items: [
    { kind: 'message', id: `c1:turn:${seq}:message:question-${seq}`, seq: 0, role: 'user', text: `question ${seq}` },
    { kind: 'message', id: `c1:turn:${seq}:message:answer-${seq}`, seq: 1, role: 'assistant', text: `answer ${seq}` },
  ] });
const rows = () => fixture.sqlite.prepare('SELECT seq,data FROM session_turns ORDER BY seq').all();

beforeEach(async () => {
  fixture = await openFixture('empty'); state.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES ('p1','P','/repo'); INSERT INTO sessions(id,project_id,title,runtime,agent_status) VALUES ('c1','p1','C','pty','idle');");
  state.row = { runtime: 'pty', provider: 'codex', providerSessionId: 'record', agentStatus: 'idle' };
  state.turns = [turn(0), turn(1)]; state.complete = true; state.available = true;
  state.pick.mockReset().mockImplementation(async (_id: string, pick: (turns: TranscriptTurn[]) => Promise<TranscriptTurn[] | null>, options: { committedOnly?: boolean }) => {
    expect(options.committedOnly).toBe(true);
    return state.available ? { ok: true, turns: await pick(state.turns), complete: state.complete } : { ok: false };
  });
  vi.mocked(events.emit).mockClear();
});
afterEach(() => { fixture.close(); });

it('stores completed history without outcome metadata, emits no live notification/activity/status facts, and is idempotent', async () => {
  const activity = vi.fn();
  const off = onActivitySignal(activity);
  const before = fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1');
  const unread = await nativeConversationUnread('c1');
  try {
    expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 2, status: 'complete' });
    expect(rows()).toHaveLength(2);
    expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'complete' });
    expect(rows()).toHaveLength(2);
    expect(await nativeConversationUnread('c1')).toEqual(unread);
    expect(fixture.sqlite.prepare('SELECT * FROM sessions WHERE id=?').get('c1')).toEqual(before);
    expect(fixture.sqlite.prepare("SELECT key FROM kv WHERE key LIKE 'native-conversation-%'").all()).toEqual([]);
    expect(events.emit).not.toHaveBeenCalled();
    expect(activity).not.toHaveBeenCalled();
  } finally { off(); }
});

it('keeps an active suffix incomplete while persisting only the timeline-owned completed prefix', async () => {
  state.turns = [turn(0)]; state.complete = false; state.row.agentStatus = 'working';
  expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'active' });
  expect(rows()).toHaveLength(1);
  state.turns = [turn(0), turn(1)]; state.complete = true; state.row.agentStatus = 'idle';
  expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
});

it('resumes after cancellation from committed canonical rows without repeating an earlier turn', async () => {
  const abort = new AbortController();
  const off = sessionEvents.on('session:history-changed', () => abort.abort());
  try {
    expect(await syncStoredHistoryFromRecord('c1', { signal: abort.signal, runtime: 'pty' })).toEqual({ inserted: 1, status: 'cancelled' });
  } finally { off(); }
  expect(rows()).toHaveLength(1);
  expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 1, status: 'complete' });
  expect(rows()).toHaveLength(2);
});

it('rechecks a presentation switch after waiting for the existing persistence queue', async () => {
  let release!: () => void;
  const prior = withStoredTurns('c1', () => new Promise<void>(resolve => { release = resolve; }));
  await Promise.resolve();
  const backfill = syncStoredHistoryFromRecord('c1', { runtime: 'pty' });
  state.row.runtime = 'acp'; release(); await prior;
  expect(await backfill).toEqual({ inserted: 0, status: 'runtime-changed' });
  expect(state.pick).not.toHaveBeenCalled();
  expect(rows()).toEqual([]);
});

it('reports missing, unsupported and divergent history without appending it', async () => {
  state.available = false;
  expect((await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).status).toBe('unavailable');
  state.available = true; state.row.provider = 'other';
  expect((await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).status).toBe('unsupported');
  state.row.provider = 'codex';
  await syncStoredHistoryFromRecord('c1', { runtime: 'pty' });
  state.turns = [{ ...turn(9), items: [{ kind: 'message', id: 'changed', seq: 0, role: 'user', text: 'different branch' }] }];
  expect(await syncStoredHistoryFromRecord('c1', { runtime: 'pty' })).toEqual({ inserted: 0, status: 'diverged' });
  expect(rows()).toHaveLength(2);
});
