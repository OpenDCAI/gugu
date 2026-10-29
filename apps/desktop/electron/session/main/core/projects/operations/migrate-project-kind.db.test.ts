// #609 已有的 app 目录项目改成 workspace:幂等、先记后改、可回滚,打在真 SQLite 上。
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

import { migrateProjectKind, rollbackProjectKindMigration } from './migrate-project-kind';

const dirs = { home: '/home/ada', guguHome: '/home/ada/.gugu', taskHome: '/data/gugu/task-home' };

describe('migrateProjectKind', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let dir: string;
  const kinds = () => Object.fromEntries(fixture.sqlite.prepare('SELECT id, kind FROM projects ORDER BY id').all().map((row: any) => [row.id, row.kind]));

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    dir = mkdtempSync(join(tmpdir(), 'gugu-project-kind-'));
    fixture.sqlite.exec(`
      INSERT INTO projects (id, name, path) VALUES ('00000000-0000-4000-8000-000000000001', '任务工作区', '/data/gugu/task-home');
      INSERT INTO projects (id, name, path) VALUES ('home', 'ada', '/home/ada');
      INSERT INTO projects (id, name, path) VALUES ('assistant', 'assistant', '/home/ada/.gugu/assistant-workdir');
      INSERT INTO projects (id, name, path) VALUES ('code', 'gugu', '/home/ada/code/gugu');
      INSERT INTO projects (id, name, path) VALUES ('home-used', 'ada', '/home/ada/../ada');
      INSERT INTO workspaces (id, kind, location, type, path, key, project_id, attached_at)
        VALUES ('ws-extra', 'path', 'local', 'local', '/home/ada/notes', 'key-extra', 'home-used', '2026-10-02T00:00:00.000Z');
    `);
  });
  afterEach(() => {
    fixture.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the 0040 migration already made the fixed task workspace a workspace', () => {
    // Inserted after the migration ran, so it is the column default here; the migration itself is covered by the UPDATE.
    expect(fixture.sqlite.prepare("SELECT dflt_value FROM pragma_table_info('projects') WHERE name = 'kind'").get()).toEqual({ dflt_value: "'project'" });
  });

  it('demotes ~ and GUGU_HOME projects without folders the person added; keeps their own projects; records first', () => {
    const file = join(dir, 'record.json');
    expect(migrateProjectKind(file, dirs).sort()).toEqual(['00000000-0000-4000-8000-000000000001', 'assistant', 'home']);
    expect(kinds()).toEqual({
      '00000000-0000-4000-8000-000000000001': 'workspace', assistant: 'workspace', code: 'project', home: 'workspace', 'home-used': 'project',
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).demoted.map((row: { id: string }) => row.id).sort())
      .toEqual(['00000000-0000-4000-8000-000000000001', 'assistant', 'home']);
    // Idempotent: nothing left to change, the record is not touched again.
    expect(migrateProjectKind(file, dirs)).toEqual([]);
    expect(JSON.parse(readFileSync(file, 'utf8')).demoted).toHaveLength(3);
  });

  it('rolls back exactly what it changed', () => {
    const file = join(dir, 'record.json');
    migrateProjectKind(file, dirs);
    expect(rollbackProjectKindMigration(file).sort()).toEqual(['00000000-0000-4000-8000-000000000001', 'assistant', 'home']);
    expect(kinds()).toEqual({
      '00000000-0000-4000-8000-000000000001': 'project', assistant: 'project', code: 'project', home: 'project', 'home-used': 'project',
    });
    expect(JSON.parse(readFileSync(file, 'utf8')).demoted).toEqual([]);
  });
});
