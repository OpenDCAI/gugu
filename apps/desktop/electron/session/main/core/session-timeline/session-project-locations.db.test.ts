import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() {
  if (!state.db) throw new Error('No database fixture');
  return state.db;
} }));
import { sessionProjectLocations } from './session-project-locations';

let fixture: Awaited<ReturnType<typeof openFixture>>;
beforeEach(async () => {
  fixture = await openFixture('empty'); state.db = fixture.db;
  fixture.sqlite.exec("INSERT INTO projects(id,name,path) VALUES('p','User project','/repo')");
  const insert = fixture.sqlite.prepare('INSERT INTO sessions(id,project_id,provider,runtime) VALUES(?,?,?,?)');
  fixture.sqlite.transaction(() => {
    for (let i = 0; i < 500; i++) insert.run(`unrelated-${i}`, 'p', 'claude', 'pty');
    insert.run('wanted', 'p', 'claude', 'pty');
  })();
});
afterEach(() => { fixture.close(); state.db = undefined; });

it('looks up only requested primary keys among hundreds of sessions, without summaries or agent discovery', () => {
  expect(sessionProjectLocations(['wanted', 'missing', 'wanted'])).toEqual([{ conversationId: 'wanted', projectId: 'p' }]);
  const plan = fixture.sqlite.prepare("EXPLAIN QUERY PLAN SELECT id,project_id FROM sessions WHERE id IN ('wanted','missing')").all() as Array<{ detail: string }>;
  expect(plan.map(row => String(row.detail)).join(' ')).toMatch(/SEARCH sessions USING INDEX/);
});

it('does no database work when no saved sessions are referenced', () => {
  state.db = undefined;
  expect(sessionProjectLocations([])).toEqual([]);
});
