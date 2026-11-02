// A new ACP session's creation turns are admitted once per creation entry, at its launch, and never by mounting a
// workspace. Each entry below runs against the real durable queue: whatever reaches the turn again (a replayed launch,
// a remount, a page opening the session) leaves exactly one pending row and one message row, so it is delivered once.
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  started: [] as string[],
  provision: vi.fn(async (_sessionId: string) => ({ success: true as const, data: { path: '/repo', workspaceId: 'root' } })),
}));
vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
// session-life's queue is the real store; a start is only recorded (the start pipeline is not under test here).
vi.mock('./session-life', async () => {
  const { enqueuePending } = await vi.importActual<typeof import('./session-pending')>('./session-pending');
  return { sessionLife: () => ({
    enqueue: (input: Parameters<typeof enqueuePending>[0]) => enqueuePending(input),
    start: (sessionId: string) => { mocks.started.push(sessionId); },
  }) };
});
vi.mock('./session-service', () => ({ sessionService: { provisionWorkspace: mocks.provision } }));

import { admitCreationTurns } from './session-life-creation';
import { launchCreatedSession } from '../session-timeline/launch-created-session';
import { getSessions } from './getSessions';

const FIRST = '把测试跑一遍';

describe('creation turns: one row per creation entry, however often it is reached', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    mocks.started = [];
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, type, kind, location, path, key) VALUES ('root', 'local', 'project-root', 'local', '/repo', 'root');
      INSERT INTO projects (id, name, path, repository_workspace_id) VALUES ('p', 'P', '/repo', 'root');
    `);
  });
  afterEach(() => { fixture.close(); mocks.db = undefined; });

  const insertSession = (id: string, config: Record<string, unknown>) => fixture.sqlite
    .prepare("INSERT INTO sessions (id, project_id, workspace_id, title, runtime, config) VALUES (?, 'p', 'root', 'T', 'acp', ?)")
    .run(id, JSON.stringify({ version: '1', type: 'acp', agentDisplayName: id, firstUtterance: FIRST, ...config }));
  const rows = (id: string) => ({
    pending: fixture.sqlite.prepare('SELECT message_id AS id FROM session_pending WHERE session_id = ?').all(id),
    messages: fixture.sqlite.prepare('SELECT id, content FROM messages WHERE session_id = ?').all(id),
  });
  const session = async (id: string) => (await getSessions()).find(candidate => candidate.id === id)!;

  it('the desktop task page: its provision request admits; asking again (the page reopened) adds nothing', async () => {
    insertSession('task', { initialQueue: [{ text: FIRST, origin: 'manual' }] });
    const { sessionCreateController } = await import('./create-controller');
    await sessionCreateController.provisionWorkspace('task');
    await sessionCreateController.provisionWorkspace('task');
    expect(rows('task')).toEqual({ pending: [{ id: 'task:creation:0' }], messages: [{ id: 'task:creation:0', content: FIRST }] });
  });

  it('a session made elsewhere (another machine, the phone, a task card, an automation): its launch admits once, a replay adds nothing', async () => {
    insertSession('remote', { initialQueue: [{ text: FIRST, origin: 'manual' }], startupOrigin: 'session-page', taskChatId: 'chat', initialMessageId: 'card-1' });
    const launch = () => launchCreatedSession({ sessionId: 'remote', projectId: 'p', runtime: 'acp', launchWorkspace: () => mocks.provision('remote') });
    await expect(launch()).resolves.toEqual({ ok: true });
    await expect(launch()).resolves.toEqual({ ok: true });
    // Mounting the workspace (here, its provision) admitted nothing of its own: the card's stable id is the only row.
    expect(rows('remote')).toEqual({ pending: [{ id: 'card-1' }], messages: [{ id: 'card-1', content: FIRST }] });
    expect(mocks.started).toEqual([]);
  });

  it('agent.create: a replayed create of the same bound session finds its first task queued (stable id)', async () => {
    insertSession('agent', {});
    const admit = async () => admitCreationTurns({ ...await session('agent'), initialQueue: [{ text: FIRST, origin: 'communication' }] });
    await admit();
    await admit();
    expect(rows('agent')).toEqual({ pending: [{ id: 'agent:creation:0' }], messages: [{ id: 'agent:creation:0', content: FIRST }] });
  });

  it('a session without creation turns is started, not queued', async () => {
    insertSession('empty', {});
    admitCreationTurns(await session('empty'));
    expect(rows('empty')).toEqual({ pending: [], messages: [] });
    expect(mocks.started).toEqual(['empty']);
  });
});
