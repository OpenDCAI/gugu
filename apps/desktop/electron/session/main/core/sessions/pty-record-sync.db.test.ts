import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { makePtySessionId } from '@shared/core/pty/ptySessionId';

const state = vi.hoisted(() => ({ sqlite: null as Database.Database | null, sync: vi.fn(), watch: vi.fn(),
  status: null as ((change: { sessionId: string; reading: { running: boolean } }) => void) | null }));
vi.mock('@main/db/client', () => ({ db: undefined, get sqlite() { return state.sqlite; } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('./record-backfill', () => ({ syncStoredHistoryFromRecord: state.sync }));
vi.mock('@main/core/session-timeline/service', () => ({ watchRecordSettled: state.watch }));
vi.mock('../agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: (_name: string, handler: typeof state.status) => {
  state.status = handler; return () => { state.status = null; };
} } }));

const { ptyRecordResumeSet, startPtyRecordSync } = await import('./pty-record-sync');
const { makeTmuxSessionName } = await import('@main/core/pty/tmux-session-name');

type Fixture = Awaited<ReturnType<typeof openFixture>>;
let fixture: Fixture;
let stop: () => void = () => {};
const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const settled = () => vi.waitFor(() => expect(state.sync).toHaveBeenCalled());

beforeEach(async () => {
  fixture = await openFixture('empty'); state.sqlite = fixture.sqlite;
  fixture.sqlite.exec(`INSERT INTO projects(id,name,path) VALUES ('p','P','/repo');
    INSERT INTO sessions(id,project_id,title,runtime,agent_status) VALUES ('s','p','S','pty','idle');`);
  state.sync.mockReset().mockResolvedValue({ inserted: 0, status: 'complete' });
  state.watch.mockReset();
});
afterEach(() => { stop(); fixture.close(); });

it('reads a terminal record at its settled edge, and only there', async () => {
  stop = startPtyRecordSync([]);
  state.status!({ sessionId: 's', reading: { running: false } });
  await flush();
  expect(state.sync).not.toHaveBeenCalled();
  state.status!({ sessionId: 's', reading: { running: true } });
  state.status!({ sessionId: 's', reading: { running: false } });
  await settled();
  expect(state.sync).toHaveBeenCalledExactlyOnceWith('s', { runtime: 'pty' });
});

it('follows a settling record until its last turn lands, then reads it again', async () => {
  state.sync.mockResolvedValueOnce({ inserted: 1, status: 'settling' });
  let land!: (settled: boolean) => void;
  state.watch.mockImplementationOnce(() => new Promise(resolve => { land = resolve; }));
  stop = startPtyRecordSync(['s']);
  await vi.waitFor(() => expect(state.watch).toHaveBeenCalledOnce());
  expect(state.watch.mock.calls[0][0]).toBe('s');
  land(true);
  await vi.waitFor(() => expect(state.sync).toHaveBeenCalledTimes(2));
});

it('ends a settling watch when a new turn starts; that turn is read at its own settled edge', async () => {
  state.sync.mockResolvedValueOnce({ inserted: 1, status: 'settling' });
  let land!: (settled: boolean) => void;
  state.watch.mockImplementationOnce((_id: string, signal: AbortSignal) => new Promise(resolve => {
    land = resolve; signal.addEventListener('abort', () => resolve(false), { once: true });
  }));
  stop = startPtyRecordSync(['s']);
  await vi.waitFor(() => expect(state.watch).toHaveBeenCalledOnce());
  const signal = state.watch.mock.calls[0][1] as AbortSignal;
  state.status!({ sessionId: 's', reading: { running: true } });
  expect(signal.aborted).toBe(true);
  land(true);
  await flush();
  expect(state.sync).toHaveBeenCalledOnce();
  state.status!({ sessionId: 's', reading: { running: false } });
  await vi.waitFor(() => expect(state.sync).toHaveBeenCalledTimes(2));
});

it('reads at boot only tasks running at shutdown, or with an unfinished record turn while tmux still runs the engine', () => {
  fixture.sqlite.exec(`INSERT INTO sessions(id,project_id,title,runtime,agent_status) VALUES
    ('running','p','R','pty','working'), ('flushing','p','F','pty','idle'), ('final','p','D','pty','idle'), ('chat','p','C','acp','working');`);
  const turn = (session: string, outcome: boolean) => fixture.sqlite.prepare('INSERT INTO session_turns(id,session_id,seq,turn_id,data) VALUES (?,?,?,?,?)')
    .run(`${session}-t`, session, 0, `record:${session}:turn:0`, JSON.stringify({ id: `${session}:turn:s0`, items: [], ...(outcome ? { outcome: { kind: 'done' } } : {}) }));
  turn('flushing', false); turn('final', false); turn('s', true);
  const tmux = new Set([makeTmuxSessionName(makePtySessionId('p', 'flushing', 'flushing'))]);
  expect(ptyRecordResumeSet(tmux).sort()).toEqual(['flushing', 'running']);
});

it('stops following records and edges when it is stopped', async () => {
  state.sync.mockResolvedValueOnce({ inserted: 0, status: 'settling' });
  state.watch.mockImplementationOnce((_id: string, signal: AbortSignal) => new Promise(resolve => signal.addEventListener('abort', () => resolve(false), { once: true })));
  stop = startPtyRecordSync(['s']);
  await vi.waitFor(() => expect(state.watch).toHaveBeenCalledOnce());
  const signal = state.watch.mock.calls[0][1] as AbortSignal;
  stop(); stop = () => {};
  expect(signal.aborted).toBe(true);
  expect(state.status).toBeNull();
});
