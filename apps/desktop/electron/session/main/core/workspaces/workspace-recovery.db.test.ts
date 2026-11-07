import { mkdtemp, mkdir, readFile, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FileSystem } from '@gugu/session-core/files';
import { openFixture, type FixtureDb } from '@tooling/utils/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppDb } from '@main/db/client';
import type { ProjectProvider } from '@main/core/projects/project-provider';
import type { WorkspaceFactoryContext } from './workspace-factory';

const h = vi.hoisted(() => ({
  db: undefined as AppDb | undefined,
  project: undefined as ProjectProvider | undefined,
  opened: false,
  factory: vi.fn(),
  create: vi.fn(),
  open: vi.fn(),
  build: vi.fn(),
}));
vi.mock('@main/db/client', () => ({ get db() { return h.db; } }));
vi.mock('@main/core/projects/project-manager', () => ({ projectManager: { getProject: () => h.opened ? h.project : undefined } }));
vi.mock('@main/core/projects/operations/openProject', () => ({ openProject: h.open }));
vi.mock('@main/core/runtime/runtime-manager', () => ({ runtimeManager: {} }));
vi.mock('@main/core/sessions/session-builder', () => ({ buildSessionFromWorkspace: h.build, emitSessionProvisionProgress: vi.fn() }));
vi.mock('./workspace-factory', () => ({ createWorkspaceFactory: h.factory }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('@main/lib/events', () => ({ events: { on: () => () => undefined, emit: vi.fn() } }));
vi.mock('electron', () => ({ protocol: { isProtocolHandled: () => false, handle: vi.fn() } }));

describe('workspace operations after the host process loses its cache', () => {
  let fixture: FixtureDb;
  let root: string;
  let registry: typeof import('./workspace-registry').workspaceRegistry;
  let files: typeof import('../files/file-system/controller').workspaceFileSystemController;
  let resolve: typeof import('../projects/utils').resolveWorkspace;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    fixture = await openFixture('empty');
    h.db = fixture.db;
    root = await mkdtemp(path.join(os.tmpdir(), 'gugu-workspace-recovery-'));
    await writeFile(path.join(root, 'note.ts'), 'before');
    fixture.sqlite.prepare('INSERT INTO projects (id, name, path, repository_workspace_id, gitless) VALUES (?, ?, ?, ?, 1)').run('p', 'Project', root, 'ws');
    fixture.sqlite.prepare("INSERT INTO workspaces (id, type, kind, location, path) VALUES ('ws', 'local', 'project-root', 'local', ?)").run(root);
    fixture.sqlite.prepare("INSERT INTO sessions (id, project_id, workspace_id, config) VALUES ('s', 'p', 'ws', ?)").run(JSON.stringify({ version: '1', type: 'acp', agentDisplayName: 'Recovery' }));
    h.project = { projectId: 'p', repoPath: root, isGitless: true, settings: {} } as ProjectProvider;
    h.opened = false;
    h.open.mockImplementation(async () => { h.opened = true; return { success: true, data: {} }; });
    h.factory.mockImplementation((id: string, context: WorkspaceFactoryContext) => async () => {
      h.create();
      return {
        workspace: {
          id, path: context.workDir, fileSystem: new FileSystem(),
          fileTree: { dispose: vi.fn() }, lifecycleService: { dispose: vi.fn() },
          gitWorktree: { getSnapshot: async () => ({ head: 'recorded-head' }) },
          dispose: vi.fn(),
        },
      };
    });
    registry = (await import('./workspace-registry')).workspaceRegistry;
    resolve = (await import('../projects/utils')).resolveWorkspace;
    files = (await import('../files/file-system/controller')).workspaceFileSystemController;
  });

  afterEach(async () => {
    await registry.teardownAll('detach');
    fixture.close();
    h.db = undefined;
    expect(path.dirname(root)).toBe(os.tmpdir());
    expect(path.basename(root)).toMatch(/^gugu-workspace-recovery-/);
    await rm(root, { recursive: true, force: true });
  });

  it('saves through the existing file RPC immediately, opening the recorded project on demand', async () => {
    expect(registry.get('ws')).toBeUndefined();
    const result = await files.writeFile('p', 'ws', 'note.ts', 'after restart');
    expect(result.success).toBe(true);
    expect(await readFile(path.join(root, 'note.ts'), 'utf8')).toBe('after restart');
    expect(h.open).toHaveBeenCalledWith('p');
    expect(h.build).not.toHaveBeenCalled();
  });

  it('coalesces concurrent cold operations without retaining a reference per read or write', async () => {
    const found = await Promise.all(Array.from({ length: 8 }, () => resolve('p', 'ws')));
    expect(found.every(workspace => workspace === found[0] && workspace?.path === root)).toBe(true);
    expect(h.create).toHaveBeenCalledTimes(1);
    const references = registry.refCount('ws');
    await resolve('p', 'ws');
    expect(registry.refCount('ws')).toBe(references);
    expect(references).toBeLessThanOrEqual(1);
  });

  it('restores through the git and preview entry points independently', async () => {
    const { gitWorktreeController } = await import('../git/worktree/controller');
    expect(await gitWorktreeController.getWorktreeSnapshot('p', 'ws')).toMatchObject({ success: true, data: { head: 'recorded-head' } });
    await registry.teardownAll('detach');
    const { createPreview, handlePreviewRequest, releasePreview } = await import('../files/preview-protocol');
    const preview = await createPreview('p', 'ws', path.join(root, 'note.ts'));
    expect(preview).not.toBeNull();
    try {
      const response = await handlePreviewRequest(new Request(preview!.url), 'pane');
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('before');
    } finally {
      releasePreview(preview!.previewId);
    }
  });

  it('restores project roots and attached folders even before they have a session', async () => {
    fixture.sqlite.exec('DELETE FROM sessions');
    expect((await resolve('p', 'ws'))?.path).toBe(root);
    const attached = path.join(root, 'attached');
    await mkdir(attached);
    fixture.sqlite.prepare("INSERT INTO workspaces (id, type, kind, location, path, project_id) VALUES ('folder', 'local', 'path', 'local', ?, 'p')").run(attached);
    expect((await resolve('p', 'folder'))?.path).toBe(attached);
  });

  it('keeps an old session association after its folder has been detached', async () => {
    fixture.sqlite.exec("UPDATE projects SET repository_workspace_id = NULL; UPDATE workspaces SET kind = 'path', project_id = NULL");
    expect((await resolve('p', 'ws'))?.path).toBe(root);
  });

  it('keeps a missing workspace as not_found and refuses an unrelated project', async () => {
    expect(await files.writeFile('p', 'missing', 'note.ts', 'bad')).toMatchObject({ success: false, error: { type: 'not_found' } });
    fixture.sqlite.prepare("INSERT INTO projects (id, name, path) VALUES ('other', 'Other', ?)").run(root + '-other');
    expect(await resolve('other', 'ws')).toBeNull();
    expect(h.factory).not.toHaveBeenCalled();
  });

  it('does not reconstruct a directory that has really been deleted', async () => {
    await rm(path.join(root, 'note.ts'));
    await rmdir(root);
    await expect(files.writeFile('p', 'ws', 'note.ts', 'must not appear')).rejects.toThrow();
    await expect(readFile(path.join(root, 'note.ts'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(h.factory).not.toHaveBeenCalled();
  });

  it('reports database read failure instead of turning it into not_found', async () => {
    const failure = vi.spyOn(fixture.db, 'select').mockImplementation(() => { throw new Error('database is unavailable'); });
    await expect(files.writeFile('p', 'ws', 'note.ts', 'bad')).rejects.toThrow('database is unavailable');
    failure.mockRestore();
    expect(await readFile(path.join(root, 'note.ts'), 'utf8')).toBe('before');
  });

  it('rejects retired remote rows before opening their recorded path on this machine', async () => {
    fixture.sqlite.exec("UPDATE workspaces SET type = 'project-ssh', location = 'remote'");
    await expect(files.writeFile('p', 'ws', 'note.ts', 'bad')).rejects.toThrow();
    expect(h.open).not.toHaveBeenCalled();
    expect(h.factory).not.toHaveBeenCalled();
  });
});
