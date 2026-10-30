import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MessageSearchStore } from './message-store';
import { projectEvents } from '../projects/project-events';
import { sessionEvents } from '../sessions/session-events';
import { startTaskSearch } from './task-search-feed';

const state = vi.hoisted(() => ({ source: null as Database.Database | null }));
vi.mock('@main/db/client', () => ({ get sqlite() { return state.source; } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { error: vi.fn() } }));
let root: string;
let store: MessageSearchStore;
let abort: AbortController;
const request = { query: { text: '', filters: { kind: 'task' as const }, sort: 'recent' as const } };
const body = (seq: number, text: string) => JSON.stringify({ id: `s:turn:s${seq}`, seq, initiator: 'user',
  items: [{ kind: 'message', id: `s:turn:s${seq}:m`, seq: 0, role: 'assistant', text }] });
const put = (seq: number, text: string) => state.source!.prepare('INSERT OR REPLACE INTO session_turns VALUES (?,?,?,?)').run('s', seq, body(seq, text), '2026-10-30 12:00:00');
function start() {
  abort = new AbortController();
  startTaskSearch(store, abort.signal, async read => {
    if (abort.signal.aborted) return false;
    store.apply(read(store));
    return true;
  });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'task-search-feed-'));
  store = new MessageSearchStore(root, 'owner');
  state.source = new Database(':memory:');
  state.source.exec(`CREATE TABLE sessions(id TEXT PRIMARY KEY,title TEXT,project_id TEXT,archived_at TEXT,agent_status TEXT,updated_at TEXT);
    CREATE TABLE session_turns(session_id TEXT,seq INTEGER,data TEXT,created_at TEXT,PRIMARY KEY(session_id,seq));
    INSERT INTO sessions VALUES ('s','Task','p',NULL,'idle','2026-10-30');`);
});
afterEach(() => { abort?.abort(); store.close(); state.source?.close(); rmSync(root, { recursive: true, force: true }); });

it('resumes a checkpoint then validates an arbitrarily old revised turn before claiming completeness', async () => {
  put(0, 'new old turn'); put(30, 'tail');
  store.apply([{ kind: 'task', task: { id: 's', title: 'Task', projectId: 'p' } },
    { kind: 'taskCoverage', coverage: { taskId: 's', lastSeq: 30, exhausted: false } }]);
  start();
  expect(store.global(request).coverage.complete).toBe(false);
  await vi.waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  expect(store.global(request).results.map(hit => hit.text)).toEqual(['tail', 'new old turn']);
});

it('replaces revised items, handles truncation, and follows committed archive/restore/title facts', async () => {
  put(0, 'original'); put(1, 'removed'); start();
  await vi.waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  put(0, 'revision');
  sessionEvents._emit('session:history-changed', { sessionId: 's', seq: 0 });
  state.source!.prepare('DELETE FROM session_turns WHERE seq>=1').run();
  sessionEvents._emit('session:history-changed', { sessionId: 's', fromSeq: 1 });
  await vi.waitFor(() => expect(store.global(request).results.map(hit => hit.text)).toEqual(['revision']));
  state.source!.prepare("UPDATE sessions SET archived_at='2026-10-30'").run();
  sessionEvents._emit('session:visibility-changed', 's');
  await vi.waitFor(() => expect(store.global(request).results).toEqual([]));
  state.source!.prepare("UPDATE sessions SET archived_at=NULL,title='Restored'").run();
  sessionEvents._emit('session:visibility-changed', 's');
  await vi.waitFor(() => expect(store.global(request).results[0]).toMatchObject({ title: 'Restored', text: 'revision' }));
});

it('reprojects a truncated sequence from current storage when a later commit has already reused it', async () => {
  put(0, 'retained'); put(1, 'removed'); start();
  await vi.waitFor(() => expect(store.global(request).coverage.complete).toBe(true));
  state.source!.prepare('DELETE FROM session_turns WHERE seq>=1').run();
  sessionEvents._emit('session:history-changed', { sessionId: 's', fromSeq: 1 });
  put(1, 'replacement');
  sessionEvents._emit('session:history-changed', { sessionId: 's', seq: 1 });
  await vi.waitFor(() => expect(store.global(request).results.map(hit => hit.text)).toEqual(['replacement', 'retained']));
});

it('purges tasks deleted by a project cascade even without individual session deletion events', async () => {
  put(0, 'cascade'); start();
  await vi.waitFor(() => expect(store.global(request).results).toHaveLength(1));
  state.source!.prepare("DELETE FROM sessions WHERE project_id='p'").run();
  projectEvents._emit('project:deleted', 'p');
  await vi.waitFor(() => expect(store.global(request).results).toEqual([]));
});

it('detaches the old lifetime before any later source commit can write it', async () => {
  put(0, 'before'); start();
  await vi.waitFor(() => expect(store.global(request).results).toHaveLength(1));
  abort.abort();
  put(0, 'after');
  sessionEvents._emit('session:history-changed', { sessionId: 's', seq: 0 });
  await Promise.resolve();
  expect(store.global(request).results[0].text).toBe('before');
});
