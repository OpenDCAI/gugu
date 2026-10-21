import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  stopSession: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/acp/controller', () => ({
  getAcpRuntimeClient: async () => ({ stopSession: mocks.stopSession }),
}));
vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: { getProject: () => null },
}));
vi.mock('@main/core/projects/utils', () => ({ resolveSession: () => null }));
vi.mock('@main/core/pty/tmux-session-name', () => ({
  killTmuxSession: vi.fn(),
  makeTmuxSessionName: vi.fn(),
}));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));

import { deleteSession } from './deleteSession';

describe('deleteConversation ACP teardown', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, title, provider, runtime)
        VALUES ('parent', 'project-1', 'Parent', 'codex', 'acp');
      INSERT INTO sessions (
        id, project_id, title, provider, runtime,
        parent_session_id, spawned_by_session_id
      ) VALUES (
        'child', 'project-1', 'Child', 'codex', 'acp', 'parent', 'parent'
      );
    `);
    mocks.stopSession.mockReset();
    mocks.stopSession.mockImplementation(({ sessionId }: { sessionId: string }) => {
      const row = fixture.sqlite
        .prepare('SELECT id FROM sessions WHERE id = ?')
        .get(sessionId);
      expect(row).toEqual({ id: 'parent' });
      return Promise.resolve({ success: true, data: undefined });
    });
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('stops the deleted ACP session, then preserves descendants as roots', async () => {
    await deleteSession('project-1', 'parent');

    expect(mocks.stopSession).toHaveBeenCalledWith({ sessionId: 'parent' });
    expect(
      fixture.sqlite
        .prepare(
          `SELECT id, parent_session_id, spawned_by_session_id
           FROM sessions ORDER BY id`
        )
        .all()
    ).toEqual([
      {
        id: 'child',
        parent_session_id: null,
        spawned_by_session_id: null,
      },
    ]);
  });
});

describe('deleteConversation and the workspace it leaves (#5665)', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    // 终端会话:resolveSession / getProject 都被 mock 成空,删除不碰任何运行时,只剩「工作区那一行收不收」这一件事。
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO workspaces (id, type, kind, path) VALUES ('shared', 'local', 'worktree', '/repo/.worktrees/shared');
      INSERT INTO workspaces (id, type, kind, path) VALUES ('alone', 'local', 'worktree', '/elsewhere');
      INSERT INTO workspaces (id, type, kind, path) VALUES ('root', 'local', 'project-root', '/repo');
      INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
        VALUES ('parent', 'project-1', 'shared', 'Parent', 'claude', 'pty');
      INSERT INTO sessions (
        id, project_id, workspace_id, title, provider, runtime,
        parent_session_id, spawned_by_session_id
      ) VALUES ('child', 'project-1', 'shared', 'Child', 'claude', 'pty', 'parent', 'parent');
      INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
        VALUES ('lonely', 'project-1', 'alone', 'Lonely', 'claude', 'pty');
      INSERT INTO sessions (id, project_id, workspace_id, title, provider, runtime)
        VALUES ('at-root', 'project-1', 'root', 'At root', 'claude', 'pty');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  const workspaceRow = (id: string) =>
    fixture.sqlite.prepare('SELECT id FROM workspaces WHERE id = ?').get(id) as { id: string } | undefined;

  // 这一条同时是下面两条的阳控:同一套 fixture 下它必须真的收掉那一行,否则两条「还在」就什么都没证明。
  it('drops the workspace row with the last session that used it', async () => {
    await deleteSession('project-1', 'lonely');
    expect(workspaceRow('alone')).toBeUndefined();
  });

  it('keeps a workspace another session still works in', async () => {
    await deleteSession('project-1', 'child');
    expect(workspaceRow('shared')).toEqual({ id: 'shared' });
  });

  it('never drops the project root', async () => {
    await deleteSession('project-1', 'at-root');
    expect(workspaceRow('root')).toEqual({ id: 'root' });
  });
});
