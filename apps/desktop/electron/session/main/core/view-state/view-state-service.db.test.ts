import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));

import { viewStateService } from './view-state-service';

const lastViewed = (projectId: string, sessionId: string) => ({
  currentViewId: 'session',
  viewParams: { session: { projectId, sessionId } },
});

// Restoring the last view: only a session known to be deleted here falls back. A session that is simply not in
// this machine's table — because it runs on another machine — is restored as it was.
describe('navigation restore: "not in this table" is not "deleted"', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('local-project', 'Project', '/repo');
      INSERT INTO sessions (id, project_id, provider, runtime, archived_at)
        VALUES ('archived', 'local-project', 'claude', 'pty', '2026-10-22T00:00:00Z');
    `);
  });

  afterEach(() => {
    fixture.close();
    mocks.db = undefined;
  });

  it('a session of another machine is restored', async () => {
    await viewStateService.save('navigation', lastViewed('server-project', 'server-session'));
    expect(await viewStateService.get('navigation')).toEqual(lastViewed('server-project', 'server-session'));
  });

  it('a session deleted from a project of this machine falls back to that project', async () => {
    await viewStateService.save('navigation', lastViewed('local-project', 'deleted-session'));
    expect(await viewStateService.get('navigation')).toEqual({
      currentViewId: 'project',
      viewParams: { project: { projectId: 'local-project' } },
    });
  });

  it('an archived session still falls back', async () => {
    await viewStateService.save('navigation', lastViewed('local-project', 'archived'));
    expect(await viewStateService.get('navigation')).toMatchObject({ currentViewId: 'project' });
  });
});
