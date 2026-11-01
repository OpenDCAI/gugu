import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
const state = vi.hoisted(() => ({ db: undefined as AppDb | undefined }));
vi.mock('@main/db/client', () => ({ get db() { if (!state.db) throw new Error('Fixture not initialized'); return state.db; } }));
import { projectionTaskProject } from './projection-task';

describe('projection creation follows the actual task lifetime', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  beforeEach(async () => {
    fixture = await openFixture('empty'); state.db = fixture.db;
    fixture.sqlite.exec(`INSERT INTO projects (id,name,path) VALUES ('projection-project','Project','/fixture');
      INSERT INTO sessions (id,project_id,provider,runtime,archived_at) VALUES
      ('active','projection-project','claude','pty',NULL),
      ('archived','projection-project','claude','pty','2026-10-30T00:00:00Z');`);
  });
  afterEach(() => { fixture.close(); state.db = undefined; });
  it('binds the project of a live local task', async () => { await expect(projectionTaskProject('active')).resolves.toBe('projection-project'); });
  it('refuses an archived task, including a callback arriving after its archive hook', async () => { await expect(projectionTaskProject('archived')).rejects.toThrow('task has ended'); });
  it('refuses a deleted task and permits the same task only after restoration', async () => {
    await expect(projectionTaskProject('missing')).rejects.toThrow('task has ended');
    fixture.sqlite.exec("UPDATE sessions SET archived_at=NULL WHERE id='archived'");
    await expect(projectionTaskProject('archived')).resolves.toBe('projection-project');
    fixture.sqlite.exec("DELETE FROM sessions WHERE id='archived'");
    await expect(projectionTaskProject('archived')).rejects.toThrow('task has ended');
  });
});
