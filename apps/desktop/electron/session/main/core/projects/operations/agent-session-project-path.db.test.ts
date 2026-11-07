// agent.create on a new account: the project it lands in has just been registered, and nothing has mounted its
// workspace yet. The path a new session binds its identity at must come from the workspace's persisted record; the
// in-memory registry only learns it once a session mounts (or the new-session page leases the draft workspace).
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openFixture } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';

const mocks = vi.hoisted(() => ({ db: undefined as AppDb | undefined, home: '' }));

vi.mock('@main/db/client', () => ({
  get db() {
    if (!mocks.db) throw new Error('Test database not initialized');
    return mocks.db;
  },
}));
vi.mock('@main/core/app/session-home-dir', () => ({ sessionHomeDir: () => mocks.home }));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { openProject: vi.fn() } }));
vi.mock('@main/core/projects/project-events', () => ({ projectEvents: { _emit: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: {
    acquire: async () => ({
      value: {
        files: {
          path: { isAbsolute: (value: string) => value.startsWith('/') },
          fileSystem: () => ({ success: true, data: { stat: async (value: string) => ({ success: true, data: { path: value, type: 'directory' } }) } }),
        },
        git: { inspectPath: async () => ({ kind: 'not-repository' }) },
      },
      release: async () => {},
    }),
  },
}));

import { persistedWorkspacePath } from '../utils';
import { workspaceRegistry } from '../../workspaces/workspace-registry';
import { resolveAgentSessionProject } from './resolve-agent-session-project';

describe('agent.create on a project nothing has mounted', () => {
  let fixture: Awaited<ReturnType<typeof openFixture>>;
  let tmp: string;

  beforeEach(async () => {
    fixture = await openFixture('empty');
    mocks.db = fixture.db;
    tmp = await mkdtemp(path.join(os.tmpdir(), 'gugu-agent-project-path-'));
    mocks.home = path.join(tmp, 'task-home');
  });

  afterEach(async () => {
    fixture.close();
    mocks.db = undefined;
    await rm(tmp, { recursive: true, force: true });
  });

  it('the implicit task home it creates has its path on record, and only there', async () => {
    const project = await resolveAgentSessionProject('');
    const workspaceId = project.repositoryWorkspaceId;
    expect(workspaceId).toBeTruthy();
    expect(workspaceRegistry.get(workspaceId!)).toBeUndefined();
    expect(persistedWorkspacePath(workspaceId!)).toBe(mocks.home);
  });

  it('a retired remote row has no local path: its stored path is never handed on as one', () => {
    fixture.sqlite.exec(`
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-ssh', 'project-root', 'remote', 'project-ssh', '/srv/app', 'k-ssh');
      INSERT INTO workspaces (id, kind, location, type, path, key) VALUES ('ws-byoi', 'byoi', 'local', 'byoi', '/srv/byoi', 'k-byoi');
    `);
    expect(persistedWorkspacePath('ws-ssh')).toBeNull();
    expect(persistedWorkspacePath('ws-byoi')).toBeNull();
    expect(persistedWorkspacePath('ws-missing')).toBeNull();
  });
});
