import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitRuntime } from '@gugu/session-core/git';
import { ok, type Result } from '@gugu/session-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IMPLICIT_SESSION_HOME_PROJECT_ID } from '@shared/core/projects/session-home-project';
import { createLocalProject, getLocalProjectPathStatus } from './create-local-project';

const mocks = vi.hoisted(() => ({
  acquireRuntimeMock: vi.fn(),
  ensureRepositoryMock: vi.fn(),
  inspectPathMock: vi.fn(),
  openRepositoryMock: vi.fn(),
  repoGetDefaultBranchMock: vi.fn(),
  repoGetRefsMock: vi.fn(),
  repoReleaseMock: vi.fn(),
  runtimeReleaseMock: vi.fn(),
  openProjectMock: vi.fn(),
  getProjectMock: vi.fn(),
  insertMock: vi.fn(),
  valuesMock: vi.fn(),
  returningMock: vi.fn(),
  transactionMock: vi.fn(),
  ensureRootMock: vi.fn(),
  fileSystemMock: vi.fn(),
  statMock: vi.fn(),
  attachedOwnerMock: vi.fn(),
  rootOwnerMock: vi.fn(),
  attachFolderMock: vi.fn(),
}));

vi.mock('@main/core/runtime/runtime-manager', () => ({
  runtimeManager: {
    acquire: mocks.acquireRuntimeMock,
  },
}));

vi.mock('@main/core/projects/project-manager', () => ({
  projectManager: {
    openProject: mocks.openProjectMock,
    getProject: mocks.getProjectMock,
  },
}));

vi.mock('./project-folders', () => ({
  getProjectOwningAttachedFolder: mocks.attachedOwnerMock,
  attachProjectFolder: mocks.attachFolderMock,
}));

vi.mock('./getProjects', () => ({ getLocalProjectByPath: mocks.rootOwnerMock }));

vi.mock('./ensure-repository-workspace', () => ({
  ensureRepositoryWorkspace: mocks.ensureRootMock,
}));

vi.mock('@main/db/client', () => ({
  db: {
    insert: mocks.insertMock,
    transaction: mocks.transactionMock,
  },
}));

function expectOk<T, E>(result: Result<T, E>): T {
  expect(result.success).toBe(true);
  if (!result.success) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.data;
}

function makeFilesRuntime() {
  return {
    path: {
      join: (...parts: string[]) => path.posix.join(...parts),
      dirname: (value: string) => path.posix.dirname(value),
      basename: (value: string) => path.posix.basename(value),
      isAbsolute: (value: string) => path.posix.isAbsolute(value),
      relative: (from: string, to: string) => path.posix.relative(from, to),
      contains: () => true,
    },
    fileSystem: mocks.fileSystemMock.mockImplementation(() =>
      ok({
        stat: mocks.statMock,
      })
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();

  mocks.insertMock.mockReturnValue({ values: mocks.valuesMock });
  mocks.transactionMock.mockImplementation((action) => action({ insert: mocks.insertMock }));
  mocks.ensureRootMock.mockReturnValue('ws-root');
  mocks.attachedOwnerMock.mockResolvedValue(undefined);
  mocks.rootOwnerMock.mockResolvedValue(undefined);
  mocks.attachFolderMock.mockResolvedValue({ success: true });
  mocks.valuesMock.mockReturnValue({ returning: () => ({ get: () => mocks.returningMock()[0] }) });
  mocks.openProjectMock.mockResolvedValue(undefined);
  mocks.getProjectMock.mockReturnValue(undefined);
  mocks.acquireRuntimeMock.mockResolvedValue({
    value: {
      files: makeFilesRuntime(),
      git: {
        ensureRepository: mocks.ensureRepositoryMock,
        inspectPath: mocks.inspectPathMock,
        openRepository: mocks.openRepositoryMock,
      },
    },
    release: mocks.runtimeReleaseMock,
  });
  mocks.ensureRepositoryMock.mockImplementation(async (projectPath: string) => ({
    success: true,
    data: { kind: 'repository', rootPath: projectPath, baseRef: 'main' },
  }));
  mocks.inspectPathMock.mockImplementation(async (projectPath: string) => ({
    kind: 'repository',
    rootPath: projectPath,
    baseRef: 'main',
  }));
  mocks.openRepositoryMock.mockResolvedValue({
    value: {
      getDefaultBranch: mocks.repoGetDefaultBranchMock,
      getRefs: mocks.repoGetRefsMock,
    },
    release: mocks.repoReleaseMock,
  });
  mocks.repoGetRefsMock.mockResolvedValue({ branches: [] });
  mocks.repoGetDefaultBranchMock.mockResolvedValue('main');
  mocks.statMock.mockResolvedValue(ok({ path: 'worktree', type: 'directory' }));
});

describe('createLocalProject', () => {
  const tempDirs: string[] = [];

  function tempProjectPath(): string {
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-project-'));
    tempDirs.push(projectPath);
    return projectPath;
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reuses the original identity when adding its detached initial folder again', async () => {
    const projectPath = tempProjectPath();
    mocks.rootOwnerMock.mockResolvedValue({
      type: 'local', id: 'original-project', name: 'Original', path: projectPath,
      rootFolderDetached: true, repositoryWorkspaceId: 'original-root', baseRef: null,
      createdAt: '2026-10-19', updatedAt: '2026-10-19',
    });
    const restored = expectOk(await createLocalProject({ path: projectPath, name: 'New name', exactPath: true }));
    expect(restored).toMatchObject({ id: 'original-project', name: 'Original', repositoryWorkspaceId: 'original-root' });
    expect(restored.rootFolderDetached).toBeUndefined();
    expect(mocks.attachFolderMock).toHaveBeenCalledWith('original-project', projectPath);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it('initializes git when the selected folder is not yet a repository', async () => {
    const projectPath = tempProjectPath();
    const row = {
      id: 'project-id',
      name: 'Project',
      path: projectPath,
      baseRef: 'main',
      createdAt: '2026-04-16T00:00:00.000Z',
      updatedAt: '2026-04-16T00:00:00.000Z',
    };

    mocks.ensureRepositoryMock.mockResolvedValueOnce({
      success: true,
      data: { kind: 'repository', rootPath: projectPath, baseRef: 'main' },
    });
    mocks.returningMock.mockReturnValue([row]);

    const created = expectOk(
      await createLocalProject({
        id: 'project-id',
        name: 'Project',
        path: projectPath,
        initGitRepository: true,
      })
    );

    expect(mocks.ensureRepositoryMock).toHaveBeenCalledWith(projectPath, {
      initIfMissing: true,
    });
    expect(mocks.openRepositoryMock).toHaveBeenCalledWith(projectPath);
    expect(created).toMatchObject({
      id: 'project-id',
      name: 'Project',
      path: projectPath,
      baseRef: 'main',
      type: 'local',
    });
    expect(mocks.openProjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'project-id',
        type: 'local',
      })
    );
  });

  it('creates a blank directory without Git, including inside a parent repository', async () => {
    const parent = tempProjectPath();
    fs.mkdirSync(path.join(parent, '.git'));
    fs.writeFileSync(path.join(parent, '.git', 'config'), 'preserve parent metadata');
    const projectPath = path.join(parent, 'new-folder');
    mocks.returningMock.mockReturnValue([{
      id: 'blank-project', name: 'New folder', path: projectPath, baseRef: null,
      createdAt: '2026-09-20T00:00:00.000Z', updatedAt: '2026-09-20T00:00:00.000Z',
    }]);

    const created = expectOk(await createLocalProject({
      id: 'blank-project', name: 'New folder', path: projectPath,
      createDirectory: true, allowNonGit: true,
    }));

    expect(created).toMatchObject({ path: projectPath, baseRef: null, repositoryWorkspaceId: 'ws-root' });
    expect(fs.statSync(projectPath).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(projectPath, '.git'))).toBe(false);
    expect(fs.readFileSync(path.join(parent, '.git', 'config'), 'utf8')).toBe('preserve parent metadata');
    expect(mocks.acquireRuntimeMock).not.toHaveBeenCalled();
    expect(mocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({ gitless: true, path: projectPath }));
  });

  // #7341 一个文件夹只属于一个项目:已经挂在项目 A 下的文件夹,「使用现有文件夹」/ agent 指过来 ⇒ 就是 A,❌ 再插一个项目。
  it('opens the owning project for a folder already attached to it instead of creating a second one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-attached-'));
    const owner = { type: 'local', id: 'project-a', name: 'gugu', path: '/www/gugu' };
    mocks.attachedOwnerMock.mockResolvedValue(owner);
    try {
      const result = await createLocalProject({ name: 'wt', path: dir, exactPath: true });
      expect(expectOk(result)).toBe(owner);
      expect(mocks.attachedOwnerMock).toHaveBeenCalledWith(dir);
      expect(mocks.insertMock).not.toHaveBeenCalled();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes the one spelling of the folder: a trailing separator is not a second project', async () => {
    const projectPath = tempProjectPath();
    mocks.returningMock.mockReturnValue([{
      id: 'p', name: 'P', path: projectPath, baseRef: null,
      createdAt: '2026-10-10T00:00:00.000Z', updatedAt: '2026-10-10T00:00:00.000Z',
    }]);

    expectOk(await createLocalProject({ name: 'P', path: `${projectPath}${path.sep}`, allowNonGit: true, exactPath: true }));

    expect(mocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({ path: projectPath }));
  });

  it('still rejects a missing selected folder when directory creation was not requested', async () => {
    const projectPath = path.join(tempProjectPath(), 'missing');
    await expect(createLocalProject({ name: 'Missing', path: projectPath, allowNonGit: true }))
      .resolves.toMatchObject({ success: false, error: { type: 'invalid-directory' } });
    expect(fs.existsSync(projectPath)).toBe(false);
    expect(mocks.insertMock).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'creates task-home without touching Git (legacy .git: %s)',
    async (hasGit) => {
      const projectPath = tempProjectPath();
      fs.writeFileSync(path.join(projectPath, 'notes.txt'), 'keep my work');
      if (hasGit) {
        fs.mkdirSync(path.join(projectPath, '.git'));
        fs.writeFileSync(path.join(projectPath, '.git', 'config'), 'keep git metadata');
      }
      mocks.returningMock.mockReturnValue([
        {
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          name: 'Task home',
          path: projectPath,
          baseRef: null,
          createdAt: '2026-09-20T00:00:00.000Z',
          updatedAt: '2026-09-20T00:00:00.000Z',
        },
      ]);

      const created = expectOk(
        await createLocalProject({
          id: IMPLICIT_SESSION_HOME_PROJECT_ID,
          name: 'Task home',
          path: projectPath,
          allowNonGit: true,
        })
      );

      expect(created.baseRef).toBeNull();
      expect(mocks.valuesMock).toHaveBeenCalledWith(
        expect.objectContaining({ gitless: true, baseRef: null })
      );
      expect(mocks.acquireRuntimeMock).not.toHaveBeenCalled();
      expect(mocks.openProjectMock).toHaveBeenCalledWith(
        expect.objectContaining({ baseRef: null })
      );
      expect(fs.readFileSync(path.join(projectPath, 'notes.txt'), 'utf8')).toBe('keep my work');
      expect(fs.existsSync(path.join(projectPath, '.git'))).toBe(hasGit);
      if (hasGit) {
        expect(fs.readFileSync(path.join(projectPath, '.git', 'config'), 'utf8')).toBe(
          'keep git metadata'
        );
      }
    }
  );

  it('rejects non-git directories unless initialization is explicitly enabled', async () => {
    const projectPath = tempProjectPath();

    mocks.ensureRepositoryMock.mockResolvedValueOnce({
      success: false,
      error: { type: 'not-repository', path: projectPath },
    });

    await expect(
      createLocalProject({
        id: 'project-id',
        name: 'Project',
        path: projectPath,
      })
    ).resolves.toEqual({
      success: false,
      error: {
        type: 'not-repository',
        path: projectPath,
      },
    });

    expect(mocks.ensureRepositoryMock).toHaveBeenCalledWith(projectPath, {
      initIfMissing: false,
    });
  });

  it('creates a non-git local folder as a gitless project when allowNonGit is set (使用现有文件夹)', async () => {
    const projectPath = tempProjectPath();

    mocks.ensureRepositoryMock.mockResolvedValueOnce({
      success: false,
      error: { type: 'not-repository', path: projectPath },
    });
    mocks.returningMock.mockReturnValue([
      {
        id: 'project-id',
        name: 'Project',
        path: projectPath,
        baseRef: null,
        createdAt: '2026-04-16T00:00:00.000Z',
        updatedAt: '2026-04-16T00:00:00.000Z',
      },
    ]);

    const created = expectOk(
      await createLocalProject({
        id: 'project-id',
        name: 'Project',
        path: projectPath,
        allowNonGit: true,
      })
    );

    expect(created).toMatchObject({ type: 'local', path: projectPath, baseRef: null });
    expect(mocks.valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ gitless: true, baseRef: null })
    );
  });

  it('keeps other Git spawn failures as project inspection errors', async () => {
    const projectPath = tempProjectPath();
    const git = new GitRuntime({ executable: projectPath });
    mocks.acquireRuntimeMock.mockResolvedValue({
      value: { files: makeFilesRuntime(), git },
      release: mocks.runtimeReleaseMock,
    });
    try {
      await expect(getLocalProjectPathStatus(projectPath)).resolves.toMatchObject({
        isDirectory: true, error: { type: 'inspect-failed' },
      });
      await expect(createLocalProject({ name: 'Project', path: projectPath, allowNonGit: true }))
        .resolves.toMatchObject({ success: false, error: { type: 'inspect-failed' } });
      expect(mocks.insertMock).not.toHaveBeenCalled();
    } finally {
      await git.dispose();
    }
  });

  it.each([false, true])('inspects and creates a folder without Git installed (metadata: %s)', async (hasMetadata) => {
    const projectPath = tempProjectPath();
    if (hasMetadata) fs.mkdirSync(path.join(projectPath, '.git'));
    const originalEntries = fs.readdirSync(projectPath);
    const git = new GitRuntime({ executable: path.join(projectPath, 'missing-git') });
    mocks.acquireRuntimeMock.mockResolvedValue({
      value: { files: makeFilesRuntime(), git },
      release: mocks.runtimeReleaseMock,
    });
    mocks.returningMock.mockReturnValue([{
      id: 'project-id', name: 'Project', path: projectPath, baseRef: null,
      createdAt: '2026-04-16T00:00:00.000Z', updatedAt: '2026-04-16T00:00:00.000Z',
    }]);
    try {
      await expect(getLocalProjectPathStatus(projectPath))
        .resolves.toEqual({ isDirectory: true, isGitRepo: false });
      const created = expectOk(await createLocalProject({
        id: 'project-id', name: 'Project', path: projectPath, allowNonGit: true,
      }));
      expect(created).toMatchObject({ path: projectPath, baseRef: null });
      expect(mocks.valuesMock).toHaveBeenCalledWith(expect.objectContaining({ gitless: true }));
      expect(mocks.openProjectMock).toHaveBeenCalledWith(created);
      expect(fs.readdirSync(projectPath)).toEqual(originalEntries);
      await expect(git.ensureRepository(projectPath, { initIfMissing: true }))
        .resolves.toMatchObject({ success: false, error: { type: 'init-failed' } });
      await expect(git.ensureRepository(projectPath))
        .resolves.toMatchObject({ success: false, error: { type: 'not-repository' } });
    } finally {
      await git.dispose();
    }
  });
});
