// 「重来」 a session-life session: its recorded first utterance is replayed as a NEW pending row (the first run's row was
// accepted, so its id would be a no-op), on a fresh run of the cleared provider session.
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { EnqueuePending } from './session-pending';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  calls: [] as string[],
  enqueued: [] as Array<{ sessionId: string; messageId: string; text: string }>,
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/core/agent-status/agent-status-writer', () => ({ agentStatusWriter: { restart: vi.fn(async () => {}) } }));
vi.mock('./hydrateSession', () => ({ hydrateSession: vi.fn(async () => { mocks.calls.push('hydrate'); }) }));
vi.mock('./session-life', async () => {
  const { enqueuePending } = await vi.importActual<typeof import('./session-pending')>('./session-pending');
  return { sessionLife: () => ({
  interrupt: async (sessionId: string, event: { reason: string }) => { mocks.calls.push(`${event.reason}:${sessionId}`); },
  // The real durable queue: the rows this writes are what a start would deliver.
  enqueue: (input: EnqueuePending) => { mocks.calls.push('enqueue'); mocks.enqueued.push(input); return enqueuePending(input); },
  }) };
});

import { restartSession } from './restart-session';

describe('restartSession on a session-life session', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    mocks.calls = []; mocks.enqueued = [];
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    const config = JSON.stringify({ version: '1', type: 'acp', firstUtterance: '把测试跑一遍', initialQueue: [{ text: '把测试跑一遍', origin: 'manual' }] });
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
    `);
    fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, workspace_id, title, runtime, provider_session_id, config) VALUES ('s', 'p', 'root', 'T', 'acp', 'native-gone', ?)").run(config);
  });
  afterEach(() => { fixture.close(); mocks.db = undefined; });

  it('replays the first utterance once as a new row, after resting the run; no initialQueue is borrowed', async () => {
    await restartSession('p', 's');
    expect(mocks.calls).toEqual(['reconfigure:s', 'enqueue']);
    expect(mocks.enqueued).toHaveLength(1);
    expect(mocks.enqueued[0]).toMatchObject({ sessionId: 's', text: '把测试跑一遍' });
    expect(mocks.enqueued[0]!.messageId).toMatch(/^s:restart:/);
    const row = fixture.sqlite.prepare('SELECT provider_session_id AS p FROM sessions WHERE id = ?').get('s') as { p: string | null };
    expect(row.p).toBeNull();
  });

  it('a session created before session-life (no earlier pending row): restart then provision leaves exactly one row', async () => {
    await restartSession('p', 's');
    // What provision does for a never-run ACP session (session-service admitFirstMessages), against the real store.
    const [{ mapSessionRowToSession }, { sessions }, { eq }, { enqueueCreationTurns }] = await Promise.all([
      import('./utils'), import('@main/db/schema'), import('drizzle-orm'), import('./session-life-creation'),
    ]);
    const session = mapSessionRowToSession(fixture.db.select().from(sessions).where(eq(sessions.id, 's')).get()!);
    if (session.initialQueue?.length) enqueueCreationTurns(session);
    const rows = fixture.sqlite.prepare("SELECT m.content AS text FROM session_pending p JOIN messages m ON m.id = p.message_id WHERE p.session_id = 's'").all();
    expect(rows).toEqual([{ text: '把测试跑一遍' }]);
  });

  it('a 重来 before the engine took the last replay is that same restart: one row, and a later press rests nothing', async () => {
    await Promise.all([restartSession('p', 's'), restartSession('p', 's')]);
    await restartSession('p', 's');
    const rows = fixture.sqlite.prepare("SELECT message_id AS id FROM session_pending WHERE session_id = 's'").all();
    expect(rows).toEqual([{ id: 's:restart:0' }]);
    expect(mocks.calls.filter(call => call.startsWith('reconfigure'))).toHaveLength(2);
  });

  it('once the engine took the replay, the next 重来 is a new replay', async () => {
    await restartSession('p', 's');
    fixture.sqlite.prepare("UPDATE session_pending SET state = 'accepted' WHERE session_id = 's'").run();
    await restartSession('p', 's');
    const rows = fixture.sqlite.prepare("SELECT message_id AS id FROM session_pending WHERE session_id = 's' ORDER BY seq").all();
    expect(rows).toEqual([{ id: 's:restart:0' }, { id: 's:restart:1' }]);
  });

});
