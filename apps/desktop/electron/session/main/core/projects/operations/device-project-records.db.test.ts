// #113 这台机器记到账号上的那一份项目:与连着时别的端读到的同一份(清单、文件夹、群),打在真 SQLite 上。
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '@gugu/session-shared';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  taps: new Set<(channel: string, data: unknown) => void>(),
}));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/lib/events', () => ({
  events: { emit: () => {} },
  tapMainEvents: (tap: (channel: string, data: unknown) => void) => {
    mocks.taps.add(tap);
    return () => mocks.taps.delete(tap);
  },
}));
vi.mock('@main/lib/logger', () => {
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { log };
});

import { setProjectGroupHost, type ProjectGroupHost } from '../project-group-host';
import { isoFromProjectTimestamp, listDeviceProjectRecords, onDeviceProjectsMaybeChanged } from './device-project-records';

function host(listBindings: ProjectGroupHost['listBindings']): ProjectGroupHost {
  const unused = async () => {
    throw new Error('not used here');
  };
  return { listBindings, ensureGroup: unused, bindToGroup: unused, unbind: unused };
}

describe('listDeviceProjectRecords', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-root-a', 'project-root', 'local', 'local', '/w/gugu', 'key-a');
      INSERT INTO projects (id, name, path, repository_workspace_id, created_at) VALUES ('project-a', 'gugu', '/w/gugu', 'ws-root-a', '2026-10-01 08:00:00');
      INSERT INTO workspaces (id, kind, location, type, path, key, project_id, attached_at)
        VALUES ('ws-wt', 'path', 'local', 'local', '/w/gugu-wt', 'key-wt', 'project-a', '2026-10-02T00:00:00.000Z');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-root-b', 'project-root', 'local', 'local', '/w/other', 'key-b');
      INSERT INTO projects (id, name, path, repository_workspace_id, created_at) VALUES ('project-b', 'other', '/w/other', 'ws-root-b', '2026-10-03 09:30:00');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-root-h', 'project-root', 'local', 'local', '/w/hidden', 'key-h');
      INSERT INTO projects (id, name, path, repository_workspace_id, root_folder_detached) VALUES ('project-hidden', 'hidden', '/w/hidden', 'ws-root-h', 1);
    `);
  });

  afterEach(() => {
    setProjectGroupHost(null);
    fixture.close();
    mocks.db = undefined;
  });

  it('lists the visible projects with their folders and groups, ❌ the hidden one', async () => {
    setProjectGroupHost(host(async () => ok([
      { projectId: 'project-a', chatId: 'chat-a', representative: true },
      { projectId: 'project-hidden', chatId: 'chat-h' },
    ])));
    const records = await listDeviceProjectRecords();
    expect(records.map((record) => record.localProjectId).sort()).toEqual(['project-a', 'project-b']);
    expect(records.find((record) => record.localProjectId === 'project-a')).toEqual({
      localProjectId: 'project-a',
      name: 'gugu',
      rootPath: '/w/gugu',
      createdAt: '2026-10-01T08:00:00.000Z',
      chatId: 'chat-a',
      groupRepresentative: true,
      folders: [
        { workspaceId: 'ws-root-a', kind: 'root', path: '/w/gugu', attachedAt: null },
        { workspaceId: 'ws-wt', kind: 'attached', path: '/w/gugu-wt', attachedAt: '2026-10-02T00:00:00.000Z' },
      ],
    });
    expect(records.find((record) => record.localProjectId === 'project-b')).toMatchObject({
      chatId: null,
      groupRepresentative: false,
      createdAt: '2026-10-03T09:30:00.000Z',
    });
  });

  it('a project whose root folder was detached keeps only its attached folders', async () => {
    fixture.sqlite.exec(`UPDATE projects SET root_folder_detached = 1 WHERE id = 'project-a'`);
    setProjectGroupHost(host(async () => ok([])));
    const record = (await listDeviceProjectRecords()).find((item) => item.localProjectId === 'project-a');
    expect(record?.folders.map((folder) => folder.workspaceId)).toEqual(['ws-wt']);
  });

  it('does not produce a set when the group bindings cannot be read (❌ a set that would split merged rows)', async () => {
    setProjectGroupHost(host(async () => err({ type: 'not-signed-in', message: 'no account' })));
    await expect(listDeviceProjectRecords()).rejects.toThrow(/not-signed-in/);
    setProjectGroupHost(null);
    await expect(listDeviceProjectRecords()).rejects.toMatchObject({ code: 'host_not_ready' });
  });
});

describe('isoFromProjectTimestamp', () => {
  it('reads the SQLite UTC timestamp as UTC, keeps an ISO one, refuses what it cannot read', () => {
    expect(isoFromProjectTimestamp('2026-10-01 08:00:00')).toBe('2026-10-01T08:00:00.000Z');
    expect(isoFromProjectTimestamp('2026-10-01T08:00:00+08:00')).toBe('2026-10-01T00:00:00.000Z');
    expect(() => isoFromProjectTimestamp('yesterday')).toThrow(/unreadable/);
  });
});

describe('onDeviceProjectsMaybeChanged', () => {
  it('fires on project, folder, visibility, group and session-created events only', () => {
    const fired: string[] = [];
    const off = onDeviceProjectsMaybeChanged(() => fired.push('x'));
    const emit = (channel: string) => mocks.taps.forEach((tap) => tap(channel, {}));
    for (const channel of [
      'project:created',
      'project:deleted',
      'project:folders-changed',
      'project:visibility-changed',
      'project:group-binding-changed',
      'session:created',
    ]) emit(channel);
    expect(fired).toHaveLength(6);
    emit('session:changed');
    emit('pty:data.some-session');
    expect(fired).toHaveLength(6);
    off();
    emit('project:created');
    expect(fired).toHaveLength(6);
  });
});
