import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageSearchStore } from './message-store';
import { projectEvents } from '../projects/project-events';
import { sessionEvents } from '../sessions/session-events';
import { startTaskSearch } from './task-search-feed';
import { awaitFact } from '../../../../../../../tests/support/awaitFact';
import type { Session } from '@shared/core/sessions/sessions';
import type { SearchIndexOp } from '@gugu/core/shared/search/types';
import { formatDeliveryTimestamp, mergeDeliveryEnvelopes, renderDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';

const state = vi.hoisted(() => ({ source: null as Database.Database | null,
  sync: vi.fn(), status: null as ((change: { sessionId: string; reading: { running: boolean } }) => void) | null }));
vi.mock('@main/db/client', () => ({ db: undefined, get sqlite() { return state.source; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
vi.mock('../sessions/record-backfill', () => ({ syncStoredHistoryFromRecord: state.sync }));
vi.mock('../agent-status/agent-status-writer', () => ({ agentStatusWriter: { on: (_name: string, handler: typeof state.status) => {
  state.status = handler; return () => { state.status = null; };
} } }));
let root: string;
let store: MessageSearchStore;
let abort: AbortController;
const request = { query: { text: '', filters: { kind: 'task' as const }, sort: 'recent' as const } };
const body = (seq: number, text: string) => JSON.stringify({ id: `s:turn:s${seq}`, seq, initiator: 'user',
  items: [{ kind: 'message', id: `s:turn:s${seq}:m`, seq: 0, role: 'assistant', text }] });
const put = (seq: number, text: string) => state.source!.prepare('INSERT OR REPLACE INTO session_turns VALUES (?,?,?,?,?)').run('s', seq, body(seq, text), '2026-10-30 12:00:00', `s:turn:s${seq}`);
const waitFor = (assertion: () => void) => awaitFact('task search projection', () => {
  try { assertion(); return true; } catch { return undefined; }
});
function start(observe?: (ops: readonly SearchIndexOp[]) => void) {
  abort = new AbortController();
  startTaskSearch(store, abort.signal, async read => {
    if (abort.signal.aborted) return false;
    const ops = read(store);
    store.apply(ops);
    observe?.(ops);
    return true;
  });
}
beforeEach(() => {
  state.sync.mockReset().mockResolvedValue({ inserted: 0, status: 'complete' });
  root = mkdtempSync(join(tmpdir(), 'task-search-feed-'));
  store = new MessageSearchStore(root, 'owner');
  state.source = new Database(':memory:');
  state.source.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,project_id TEXT,archived_at TEXT,agent_status TEXT,updated_at TEXT,runtime TEXT);
    CREATE TABLE projects(id TEXT PRIMARY KEY,workspace_provider TEXT);
    INSERT INTO projects VALUES ('p','local');
    CREATE TABLE session_turns(session_id TEXT,seq INTEGER,data TEXT,created_at TEXT,turn_id TEXT,PRIMARY KEY(session_id,seq));
    INSERT INTO sessions VALUES ('s','Task','p',NULL,'idle','2026-10-30','acp');`);
});
afterEach(() => { abort?.abort(); store.close(); state.source?.close(); rmSync(root, { recursive: true, force: true }); });

it('resumes a checkpoint then validates an arbitrarily old revised turn before claiming completeness', async () => {
  put(0, 'new old turn'); put(30, 'tail');
  store.apply([{ kind: 'task', task: { id: 's', title: 'Task', projectId: 'p' } },
    { kind: 'taskCoverage', coverage: { taskId: 's', lastSeq: 30, exhausted: false } }]);
  start();
  expect(store.global(request).coverage.complete).toBe(false);
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(store.global(request).results.map(hit => hit.text)).toEqual(['tail', 'new old turn']);
});

it('scans existing archived PTY tasks through the same queue and indexes only visible conversation bodies', async () => {
  put(0, 'terminal body');
  const stored = JSON.parse(body(0, 'terminal body'));
  stored.items.push({ kind: 'thinking', id: 'thought', seq: 1, text: 'private-thought' },
    { kind: 'execute-tool-call', id: 'tool', seq: 2, toolCallId: 'tool', status: 'done', command: 'private-call', output: 'private-output' });
  state.source!.prepare('UPDATE session_turns SET data=?').run(JSON.stringify(stored));
  state.source!.prepare("UPDATE sessions SET runtime='pty',archived_at='2026-10-30'").run();
  start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(state.sync).toHaveBeenCalledExactlyOnceWith('s', { signal: abort.signal, runtime: 'pty' });
  expect(store.global(request).results).toMatchObject([{ text: 'terminal body', archived: true }]);
  for (const text of ['private-thought', 'private-call', 'private-output']) {
    expect(store.global({ query: { ...request.query, text } }).results).toEqual([]);
  }
});

it('reports missing record history without exhausting it, then retries on the existing settled-status fact', async () => {
  state.source!.prepare("UPDATE sessions SET runtime='pty'").run();
  state.sync.mockResolvedValueOnce({ inserted: 0, status: 'unavailable' });
  start();
  await waitFor(() => expect(store.taskCoverage()).toEqual([{ taskId: 's', lastSeq: -1, exhausted: false, reason: 'unavailable' }]));
  expect(store.global(request).coverage.complete).toBe(false);
  state.status!({ sessionId: 's', reading: { running: true } });
  state.status!({ sessionId: 's', reading: { running: false } });
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(state.sync).toHaveBeenCalledTimes(2);
});

it('does not reparse completed PTY records on reopen or idle republish, and never wipes on a settled edge', async () => {
  state.source!.prepare("UPDATE sessions SET runtime='pty'").run();
  put(0, 'retained body');
  start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  abort.abort(); store.close(); store = new MessageSearchStore(root, 'owner');
  const ops: SearchIndexOp[] = [];
  start(batch => ops.push(...batch));
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(state.sync).toHaveBeenCalledOnce();
  ops.length = 0;
  state.status!({ sessionId: 's', reading: { running: false } });
  expect(ops).toEqual([]);
  expect(store.global(request).results.map(hit => hit.text)).toEqual(['retained body']);
  state.status!({ sessionId: 's', reading: { running: true } });
  state.status!({ sessionId: 's', reading: { running: false } });
  expect(store.global(request).results.map(hit => hit.text)).toEqual(['retained body']);
  await waitFor(() => { expect(state.sync).toHaveBeenCalledTimes(2); expect(store.global(request).coverage.complete).toBe(true); });
  expect(ops.filter(op => op.kind === 'truncateTask').every(op => op.fromSeq > 0)).toBe(true);
});

it.each(['unsupported', 'diverged'])('settles %s records while retaining the unavailable-history reason', async status => {
  state.source!.prepare("UPDATE sessions SET runtime='pty'").run();
  state.sync.mockResolvedValue({ inserted: 0, status });
  start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(store.taskCoverage()).toEqual([{ taskId: 's', lastSeq: -1, exhausted: true, reason: status }]);
  abort.abort(); store.close(); store = new MessageSearchStore(root, 'owner');
  start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(state.sync).toHaveBeenCalledOnce();
  expect(store.taskCoverage()[0].reason).toBe(status);
});

it('does not begin another existing PTY task after the account closes during record backfill', async () => {
  state.source!.prepare("UPDATE sessions SET runtime='pty'").run();
  state.source!.prepare("INSERT INTO sessions VALUES ('other','Other','p',NULL,'idle','2026-10-29','pty')").run();
  let finish!: (value: { inserted: number; status: string }) => void;
  state.sync.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  start();
  await waitFor(() => expect(state.sync).toHaveBeenCalledOnce());
  abort.abort();
  finish({ inserted: 0, status: 'cancelled' });
  await Promise.resolve();
  expect(state.sync).toHaveBeenCalledOnce();
  expect(store.global(request).results).toEqual([]);
});

it('uses the command palette local-project predicate to exclude retired remote project tasks', () => {
  put(0, 'remote body');
  state.source!.prepare("UPDATE projects SET workspace_provider='ssh'").run();
  start();
  expect(store.tasks()).toEqual([]);
  expect(store.global(request).results).toEqual([]);
});

it('retains an earlier visible delivery when a later copy in another turn is truncated', async () => {
  const text = renderDeliveryEnvelope({ route: 'session-direct', from: 'Sender', fromId: 'user:person',
    messageId: 'msg:same-delivery', at: formatDeliveryTimestamp('2026-10-30T12:00:00Z'), content: 'deliveryneedle' });
  put(5, text); put(9, mergeDeliveryEnvelopes([text, text]));
  // Deliveries enter the transcript as user messages, with independent durable turn references.
  state.source!.prepare("UPDATE session_turns SET data=json_set(data,'$.items[0].role','user')").run();
  start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(store.global(request).results.map(hit => hit.seq)).toEqual([9, 5]);
  state.source!.prepare('DELETE FROM session_turns WHERE seq>=7').run();
  sessionEvents._emit('session:history-changed', { sessionId: 's', fromSeq: 7 });
  await waitFor(() => expect(store.global(request).results.map(hit => [hit.seq, hit.text])).toEqual([[5, 'deliveryneedle']]));
});

it('shares replay visibility with the transcript and rechecks successors after an old revision', async () => {
  const original = (seq: number, settled: boolean) => {
    const id = `s:turn:s${seq}`;
    return JSON.stringify({ id, seq, initiator: 'user', ...(settled ? { startedAt: 1000, outcome: { kind: 'done' } } : {}),
      items: [
        { kind: 'message', id: `${id}:message:11111111-1111-4111-8111-111111111111`, seq: 0, role: 'user', text: 'question' },
        { kind: 'message', id: `${id}:message:22222222-2222-4222-8222-222222222222`, seq: 1, role: 'assistant', text: 'answer' },
      ] });
  };
  put(0, ''); put(1, '');
  state.source!.prepare('UPDATE session_turns SET data=? WHERE seq=0').run(original(0, true));
  state.source!.prepare('UPDATE session_turns SET data=? WHERE seq=1').run(original(1, false));
  start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(store.global(request).results).toHaveLength(2);
  expect(store.global(request).results.every(hit => hit.kind === 'task' && hit.reference.startsWith('s:turn:s0:'))).toBe(true);
  // Changing the predecessor's real identities makes the old replay row independently visible.
  state.source!.prepare('UPDATE session_turns SET data=? WHERE seq=0').run(original(0, true).replaceAll('11111111', '33333333'));
  sessionEvents._emit('session:history-changed', { sessionId: 's', seq: 0 });
  await waitFor(() => expect(store.global(request).results).toHaveLength(4));
});

it('pages oversized source turns alone without regressing the persisted tail during prefix validation', async () => {
  put(0, 'first'); put(9, 'tail');
  const large = JSON.parse(body(0, 'first'));
  large.items.push({ kind: 'thinking', id: 'private', seq: 1, text: 'x'.repeat(1024 * 1024) });
  state.source!.prepare('UPDATE session_turns SET data=? WHERE seq=0').run(JSON.stringify(large));
  store.apply([{ kind: 'task', task: { id: 's', title: 'Task', projectId: 'p' } },
    { kind: 'taskCoverage', coverage: { taskId: 's', lastSeq: 9, exhausted: false } }]);
  const prefixPages: number[] = [];
  start(() => {
    const texts = store.global(request).results.map(hit => hit.text);
    if (texts.includes('first') && !texts.includes('tail')) prefixPages.push(store.taskCoverage()[0].lastSeq);
  });
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(prefixPages.length).toBeGreaterThan(0);
  expect(prefixPages.every(cursor => cursor === 9)).toBe(true);
  expect(store.global(request).results.map(hit => hit.text)).toEqual(['tail', 'first']);
});

it('replaces revised items, handles truncation, and follows committed archive/restore/title facts', async () => {
  put(0, 'original'); put(1, 'removed'); start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  put(0, 'revision');
  sessionEvents._emit('session:history-changed', { sessionId: 's', seq: 0 });
  state.source!.prepare('DELETE FROM session_turns WHERE seq>=1').run();
  sessionEvents._emit('session:history-changed', { sessionId: 's', fromSeq: 1 });
  await waitFor(() => expect(store.global(request).results.map(hit => hit.text)).toEqual(['revision']));
  state.source!.prepare("UPDATE sessions SET archived_at='2026-10-30'").run();
  sessionEvents._emit('session:archived', 's');
  await waitFor(() => expect(store.global(request).results).toMatchObject([{ text: 'revision', archived: true }]));
  state.source!.prepare("UPDATE sessions SET archived_at=NULL,title='Restored'").run();
  sessionEvents._emit('session:created', { id: 's' } as Session);
  await waitFor(() => expect(store.global(request).results[0]).toMatchObject({ title: 'Restored', text: 'revision' }));
});

it('reprojects a truncated sequence from current storage when a later commit has already reused it', async () => {
  put(0, 'retained'); put(1, 'removed'); start();
  await waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  state.source!.prepare('DELETE FROM session_turns WHERE seq>=1').run();
  sessionEvents._emit('session:history-changed', { sessionId: 's', fromSeq: 1 });
  put(1, 'replacement');
  sessionEvents._emit('session:history-changed', { sessionId: 's', seq: 1 });
  await waitFor(() => expect(store.global(request).results.map(hit => hit.text)).toEqual(['replacement', 'retained']));
});

it('purges tasks deleted by a project cascade even without individual session deletion events', async () => {
  put(0, 'cascade'); start();
  await waitFor(() => expect(store.global(request).results).toHaveLength(1));
  state.source!.prepare("DELETE FROM sessions WHERE project_id='p'").run();
  projectEvents._emit('project:deleted', 'p');
  await waitFor(() => expect(store.global(request).results).toEqual([]));
});

it('detaches the old lifetime before any later source commit can write it', async () => {
  put(0, 'before'); start();
  await waitFor(() => expect(store.global(request).results).toHaveLength(1));
  abort.abort();
  put(0, 'after');
  sessionEvents._emit('session:history-changed', { sessionId: 's', seq: 0 });
  await Promise.resolve();
  expect(store.global(request).results[0].text).toBe('before');
});
