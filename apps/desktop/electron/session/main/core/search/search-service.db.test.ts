import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixtureRef = vi.hoisted(() => ({
  current: undefined as Awaited<ReturnType<typeof openFixture>> | undefined,
}));

vi.mock('@main/db/client', () => ({
  get db() {
    return fixtureRef.current!.db;
  },
  get sqlite() {
    return fixtureRef.current!.sqlite;
  },
}));

const { sessions, projects } = await import('@main/db/schema');
const { searchService } = await import('./search-service');

// 已下架的 SSH 远程项目(#6264)行原样留在库里:命令面板的搜索与「最近」都不能再把它们递出来。
describe('SearchService · retired SSH projects', () => {
  beforeEach(async () => {
    fixtureRef.current = await openFixture('empty');
    const { db } = fixtureRef.current;
    await db.insert(projects).values([
      { id: 'proj-local', name: 'alpha local', path: '/repo/local', workspaceProvider: 'local' },
      { id: 'proj-ssh', name: 'alpha remote', path: '/srv/remote', workspaceProvider: 'ssh' },
    ]);
    await db.insert(sessions).values([
      { id: 'session-local', projectId: 'proj-local', title: 'alpha session local' },
      { id: 'session-ssh', projectId: 'proj-ssh', title: 'alpha session remote' },
    ]);
    searchService.initialize();
  });

  afterEach(() => {
    fixtureRef.current?.close();
    fixtureRef.current = undefined;
  });

  it('keeps retired projects and their sessions out of search results', () => {
    const ids = searchService.search({ query: 'alpha' }).map((item) => item.id);
    expect(ids).toEqual(expect.arrayContaining(['proj-local', 'session-local']));
    expect(ids).not.toContain('proj-ssh');
    expect(ids).not.toContain('session-ssh');
  });

  it('keeps sessions of retired projects out of recents', () => {
    const ids = searchService.search({ query: '' }).map((item) => item.id);
    expect(ids).toContain('session-local');
    expect(ids).not.toContain('session-ssh');
  });

  it('does not backfill archived projects and restores the project search entry with its task', async () => {
    const { db, sqlite } = fixtureRef.current!;
    sqlite.exec("UPDATE projects SET archived_at='2026-10-30' WHERE id='proj-local'; UPDATE sessions SET archived_at='2026-10-30' WHERE id='session-local'; DELETE FROM search_index;");
    searchService.initialize();
    expect(searchService.search({ query: 'alpha' }).map(item => item.id)).not.toContain('proj-local');
    const { eq } = await import('drizzle-orm');
    const { sessionEvents } = await import('../sessions/session-events');
    const { mapSessionRowToSession } = await import('../sessions/utils');
    sqlite.exec("UPDATE projects SET archived_at=NULL WHERE id='proj-local'; UPDATE sessions SET archived_at=NULL WHERE id='session-local';");
    const row = db.select().from(sessions).where(eq(sessions.id, 'session-local')).get()!;
    sessionEvents._emit('session:created', mapSessionRowToSession(row));
    expect(searchService.search({ query: 'alpha' }).map(item => item.id)).toContain('proj-local');
  });
});
