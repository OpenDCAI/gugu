import type { IFileSystem } from '@gugu/session-core/files';
import { err, ok } from '@gugu/session-shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeProjectSettingsOverrideState } from './project-settings-override-state';
import {
  getProjectSettingsWriteTargets,
  resolveAllProjectSettingsTargets,
} from './project-settings-target-resolver';
import { shareProjectSettingsToConfig } from './share-project-settings-to-config';

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  workspaceGet: vi.fn(),
  listForProject: vi.fn(),
}));

vi.mock('@main/core/workspaces/workspace-registry', () => ({
  workspaceRegistry: {
    get: mocks.workspaceGet,
    listForProject: mocks.listForProject,
  },
}));

vi.mock('@main/db/client', () => ({
  db: {
    select: mocks.select,
  },
}));

vi.mock('../utils', () => ({
  resolveWorkspace: vi.fn().mockReturnValue(null),
}));

vi.mock('@main/lib/logger', () => ({
  log: {
    warn: vi.fn(),
  },
}));

const repoPath = '/repo';
const configPath = `${repoPath}/.gugu.json`;

function createMemoryFileSystem(initialFiles: Record<string, string> = {}) {
  const files = new Map(
    Object.entries(initialFiles).map(([filePath, content]) => [
      filePath.startsWith('/') ? filePath : `${repoPath}/${filePath}`,
      content,
    ])
  );
  const fileSystem = {
    exists: vi.fn(async (filePath: string) => ok(files.has(filePath))),
    readText: vi.fn(async (filePath: string) => {
      const content = files.get(filePath);
      if (content === undefined) {
        return err({
          type: 'fs-error' as const,
          path: filePath,
          message: `Missing file: ${filePath}`,
          code: 'ENOENT',
        });
      }
      return ok({ content, truncated: false, totalSize: Buffer.byteLength(content) });
    }),
    writeText: vi.fn(async (filePath: string, content: string) => {
      files.set(filePath, content);
      return ok({ bytesWritten: Buffer.byteLength(content) });
    }),
    readBytes: vi.fn(),
    writeBytes: vi.fn(),
    stat: vi.fn(),
    mkdir: vi.fn(),
    remove: vi.fn(),
    rename: vi.fn(),
    realPath: vi.fn(),
    copyFile: vi.fn(),
    glob: vi.fn(),
    enumerate: vi.fn(),
    content(filePath: string) {
      return files.get(filePath) ?? files.get(`${repoPath}/${filePath}`);
    },
  };
  return fileSystem as unknown as IFileSystem & typeof fileSystem;
}

function joinPath(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/');
}

function configPathForDirectory(directoryPath: string): string {
  return joinPath(directoryPath, '.gugu.json');
}

function projectFixture(fileSystem: IFileSystem, overrides: Record<string, unknown> = {}) {
  return {
    projectId: 'project-1',
    repoPath,
    fileSystem,
    projectConfigPath: configPath,
    resolveProjectPath: (relativePath: string) => joinPath(repoPath, relativePath),
    configPathForDirectory,
    ...overrides,
  };
}

function workspaceFixture(workspacePath: string, fileSystem: IFileSystem) {
  return {
    path: workspacePath,
    fileSystem,
    configPath: configPathForDirectory(workspacePath),
  };
}

function projectTarget(fileSystem: IFileSystem) {
  return { type: 'project' as const, label: 'Repo Name', path: repoPath, fileSystem, configPath };
}

describe('shareProjectSettingsToConfig', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workspaceGet.mockReturnValue(undefined);
    mocks.listForProject.mockReturnValue([]);
  });

  it('writes selected shareable project settings to .gugu.json', async () => {
    const fileSystem = createMemoryFileSystem();
    const write = fileSystem.writeText;
    const patch = vi.fn().mockResolvedValue({ success: true });
    const project = {
      settings: {
        get: vi.fn().mockResolvedValue({
          defaultBranch: 'origin/main',
          baseRemote: 'origin',
          tmux: true,
          preservePatterns: ['.env', '.env.local'],
          shellSetup: 'nvm use',
          scripts: {
            setup: 'pnpm install',
            run: 'pnpm dev',
          },
        }),
        patch,
      },
    };

    const result = await shareProjectSettingsToConfig(
      project as never,
      {
        target: { type: 'project' },
        fields: ['preservePatterns', 'shellSetup', 'scripts.setup', 'scripts.run'],
      },
      [projectTarget(fileSystem)]
    );

    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith(
      configPath,
      `${JSON.stringify(
        {
          preservePatterns: ['.env', '.env.local'],
          shellSetup: 'nvm use',
          scripts: {
            setup: 'pnpm install',
            run: 'pnpm dev',
          },
        },
        null,
        2
      )}\n`
    );
    expect(patch).toHaveBeenCalledWith({
      clearShareableFields: ['preservePatterns', 'shellSetup', 'scripts.setup', 'scripts.run'],
    });
  });

  it('only clears fields that were actually written to .gugu.json', async () => {
    const fileSystem = createMemoryFileSystem({
      '.gugu.json': JSON.stringify({ preservePatterns: ['.env'] }),
    });
    const write = fileSystem.writeText;
    const patch = vi.fn().mockResolvedValue({ success: true });
    const project = {
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env.local'],
        }),
        patch,
      },
    };

    const result = await shareProjectSettingsToConfig(
      project as never,
      {
        target: { type: 'project' },
        fields: ['preservePatterns', 'scripts.run'],
      },
      [projectTarget(fileSystem)]
    );

    expect(result.success).toBe(true);
    expect(write).toHaveBeenCalledWith(
      configPath,
      `${JSON.stringify({ preservePatterns: ['.env.local'] }, null, 2)}\n`
    );
    expect(patch).toHaveBeenCalledWith({
      clearShareableFields: ['preservePatterns'],
    });
  });

  it('returns an error when the filesystem reports an unsuccessful write', async () => {
    const patch = vi.fn();
    const fileSystem = {
      ...createMemoryFileSystem(),
      writeText: vi.fn(async (filePath: string) =>
        err({
          type: 'fs-error' as const,
          path: filePath,
          message: 'permission denied',
        })
      ),
    };
    const project = {
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env'],
        }),
        patch,
      },
    };

    const result = await shareProjectSettingsToConfig(
      project as never,
      {
        target: { type: 'project' },
        fields: ['preservePatterns'],
      },
      [projectTarget(fileSystem as never)]
    );

    expect(result).toEqual({
      success: false,
      error: {
        type: 'write-config-failed',
        message: 'Could not write .gugu.json: permission denied',
      },
    });
    expect(patch).not.toHaveBeenCalled();
  });

  it('returns an error when clearing shared fields fails after writing config', async () => {
    const fileSystem = createMemoryFileSystem({
      '.gugu.json': `${JSON.stringify({ shellSetup: 'old setup' }, null, 2)}\n`,
    });
    const write = fileSystem.writeText;
    const patch = vi.fn().mockResolvedValue({
      success: false,
      error: { type: 'error' },
    });
    const project = {
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env'],
        }),
        patch,
      },
    };

    const result = await shareProjectSettingsToConfig(
      project as never,
      {
        target: { type: 'project' },
        fields: ['preservePatterns'],
      },
      [projectTarget(fileSystem)]
    );

    expect(result).toEqual({
      success: false,
      error: {
        type: 'write-config-failed',
        message: 'Wrote .gugu.json, but failed to clear shared project settings.',
      },
    });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns the read/parse failure when existing .gugu.json cannot be parsed', async () => {
    const fileSystem = createMemoryFileSystem({ '.gugu.json': '{ invalid json' });
    const project = {
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env'],
        }),
      },
    };

    const result = await shareProjectSettingsToConfig(
      project as never,
      {
        target: { type: 'project' },
        fields: ['preservePatterns'],
      },
      [projectTarget(fileSystem)]
    );

    if (result.success) {
      throw new Error('Expected write to fail');
    }
    expect(result.error).toMatchObject({
      type: 'write-config-failed',
    });
    if (result.error.type !== 'write-config-failed') {
      throw new Error(`Unexpected error type: ${result.error.type}`);
    }
    expect(result.error.message).toContain('Could not read existing .gugu.json');
  });

  it('does not overwrite an existing .gugu.json when the read is truncated', async () => {
    const fileSystem = {
      ...createMemoryFileSystem({ '.gugu.json': '{"shellSetup":' }),
      readText: vi.fn(async () =>
        ok({ content: '{"shellSetup":', truncated: true, totalSize: 204_801 })
      ),
    };
    const project = {
      settings: {
        get: vi.fn().mockResolvedValue({
          preservePatterns: ['.env'],
        }),
        patch: vi.fn(),
      },
    };

    const result = await shareProjectSettingsToConfig(
      project as never,
      {
        target: { type: 'project' },
        fields: ['preservePatterns'],
      },
      [projectTarget(fileSystem as never)]
    );

    expect(result).toEqual({
      success: false,
      error: {
        type: 'write-config-failed',
        message: 'Could not read existing .gugu.json: file was truncated.',
      },
    });
    expect(fileSystem.writeText).not.toHaveBeenCalled();
  });

  it('returns target resolution failures instead of rejecting the RPC', async () => {
    await expect(
      shareProjectSettingsToConfig(
        {
          settings: {
            get: vi.fn(),
          },
        } as never,
        {
          target: { type: 'workspace', workspaceId: 'gone-workspace' },
          fields: ['preservePatterns'],
        },
        []
      )
    ).resolves.toEqual({
      success: false,
      error: {
        type: 'write-config-failed',
        message: 'Could not resolve the selected working copy.',
      },
    });
  });

  it('lists each session working copy once and excludes the project root working directory', async () => {
    const projectRootFs = createMemoryFileSystem({
      '.gugu.json': JSON.stringify({ shellSetup: 'root setup' }),
    });
    const worktreeFs = createMemoryFileSystem({
      '/repo/.emdash/worktrees/session-two/.gugu.json': JSON.stringify({
        shellSetup: 'worktree setup',
      }),
    });
    const findBranchAnywhere = vi.fn();
    const project = projectFixture(projectRootFs, {
      worktreeService: {
        findBranchAnywhere,
      },
    });
    mocks.workspaceGet.mockImplementation((workspaceId: string) => {
      if (workspaceId === 'root-workspace') {
        return workspaceFixture('/repo', projectRootFs);
      }
      if (workspaceId === 'worktree-workspace') {
        return workspaceFixture('/repo/.emdash/worktrees/session-two', worktreeFs);
      }
      return undefined;
    });
    mocks.select
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: vi.fn().mockResolvedValue([{ name: 'Repo Name' }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: vi.fn().mockResolvedValue([
            { id: 's-root', config: { version: '1', type: 'acp', agentDisplayName: 'Root Session' }, workspaceId: 'root-workspace' },
            { id: 's-two', config: { version: '1', type: 'acp', agentDisplayName: 'Session Two' }, workspaceId: 'worktree-workspace' },
            // 同一个工作区上的第二条会话:目标只列一次。
            { id: 's-two-fork', config: { version: '1', type: 'acp', agentDisplayName: 'Session Two Fork' }, workspaceId: 'worktree-workspace' },
          ]),
        }),
      });

    const resolvedTargets = await resolveAllProjectSettingsTargets(project as never);
    const targets = getProjectSettingsWriteTargets(resolvedTargets);
    const overrideState = await computeProjectSettingsOverrideState(resolvedTargets);

    expect(targets).toEqual([
      { type: 'project', label: 'Repo Name', path: '/repo' },
      {
        type: 'workspace',
        workspaceId: 'worktree-workspace',
        label: 'Session Two',
        path: '/repo/.emdash/worktrees/session-two',
      },
    ]);
    expect(overrideState.shellSetup).toEqual([
      { label: 'Repo Name', path: '/repo', value: 'root setup' },
      {
        label: 'Session Two',
        path: '/repo/.emdash/worktrees/session-two',
        value: 'worktree setup',
      },
    ]);
  });

  it('detects workspace setting overrides from .gugu.json files', async () => {
    const projectFs = createMemoryFileSystem({
      '.gugu.json': JSON.stringify({
        preservePatterns: ['.env', '.env.local'],
        shellSetup: 'nvm use',
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
          teardown: 'docker compose down',
        },
      }),
    });
    const project = projectFixture(projectFs, {
      worktreeService: {
        findBranchAnywhere: vi.fn(),
      },
    });
    mocks.select
      .mockReturnValueOnce({
        from: () => ({
          where: () => ({
            limit: vi.fn().mockResolvedValue([{ name: 'Repo Name' }]),
          }),
        }),
      })
      .mockReturnValueOnce({
        from: () => ({
          where: vi.fn().mockResolvedValue([]),
        }),
      });

    await expect(
      computeProjectSettingsOverrideState(await resolveAllProjectSettingsTargets(project as never))
    ).resolves.toEqual({
      preservePatterns: [
        {
          label: 'Repo Name',
          path: '/repo',
          value: '.env\n.env.local',
        },
      ],
      shellSetup: [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'nvm use',
        },
      ],
      'scripts.setup': [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'pnpm install',
        },
      ],
      'scripts.run': [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'pnpm dev',
        },
      ],
      'scripts.teardown': [
        {
          label: 'Repo Name',
          path: '/repo',
          value: 'docker compose down',
        },
      ],
    });
  });
});
