import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import { sessionChangedChannel } from '@shared/core/sessions/sessionEvents';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  emit: vi.fn(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

vi.mock('@main/lib/events', () => ({
  events: { emit: mocks.emit },
}));

import { setSessionPinned } from './setSessionPinned';

// 桌面侧栏与手机都经这一个写入口改置顶:渲染层收一条变更(手机的列表订阅旁听的也是这一条)。
describe('setSessionPinned', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    mocks.emit.mockReset();
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('project-1', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime)
        VALUES ('conv-1', 'project-1', 'codex', 'acp');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('writes the flag and announces it on the conversation-changed channel', async () => {
    await setSessionPinned('conv-1', true);

    const row = fixture.sqlite
      .prepare('SELECT is_pinned FROM sessions WHERE id = ?')
      .get('conv-1') as { is_pinned: number };
    expect(row.is_pinned).toBe(1);
    expect(mocks.emit).toHaveBeenCalledWith(sessionChangedChannel, {
      sessionId: 'conv-1',
      projectId: 'project-1',
      changes: { isPinned: true },
    });
  });

  it('announces nothing for a conversation that does not exist', async () => {
    await expect(setSessionPinned('missing', true)).rejects.toThrow(/not found/);
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
