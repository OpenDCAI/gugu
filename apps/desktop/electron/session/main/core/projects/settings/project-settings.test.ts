import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { IFileSystem } from '@gugu/session-core/files';
import { err, ok } from '@gugu/session-shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PRESERVE_PATTERNS } from '@shared/core/project-settings/project-settings';
import type { ProjectSettingsStorage } from './project-settings-storage';
import { LocalProjectSettingsProvider } from './providers/local-project-settings-provider';

const storageMockState = vi.hoisted(() => ({
  storage: undefined as ProjectSettingsStorage | undefined,
}));

function makeTrackingGit(isFileCleanlyTracked: boolean) {
  return {
    isFileCleanlyTracked: vi.fn().mockResolvedValue(isFileCleanlyTracked),
  };
}

const projectId = () => `project-${randomUUID()}`;

function tempProjectPath(tempDirs: string[]): string {
  const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'emdash-settings-local-'));
  tempDirs.push(projectPath);
  return projectPath;
}

function makeLocalConfigReader(projectPath: string): Pick<IFileSystem, 'exists' | 'readText'> {
  const resolvePath = (filePath: string) =>
    path.isAbsolute(filePath) ? filePath : path.join(projectPath, filePath);
  return {
    exists: vi.fn(async (filePath: string) => ok(fs.existsSync(resolvePath(filePath)))),
    readText: vi.fn(async (filePath: string) => {
      try {
        const content = fs.readFileSync(resolvePath(filePath), 'utf8');
        return ok({ content, truncated: false, totalSize: Buffer.byteLength(content) });
      } catch {
        return err({
          type: 'fs-error' as const,
          path: filePath,
          message: `File not found: ${filePath}`,
          code: 'ENOENT',
        });
      }
    }),
  };
}

function makeLocalProvider(
  projectPath: string,
  options?: ConstructorParameters<typeof LocalProjectSettingsProvider>[4]
): LocalProjectSettingsProvider {
  return new LocalProjectSettingsProvider(
    projectId(),
    projectPath,
    'main',
    makeLocalConfigReader(projectPath),
    options
  );
}

vi.mock('@main/core/settings/settings-service', () => ({
  appSettingsService: {
    get: vi.fn().mockImplementation((key: string) => {
      if (key === 'project') return Promise.resolve({ tmuxByDefault: false });
      return Promise.resolve({
        defaultWorktreeDirectory: '/tmp/emdash/worktrees',
      });
    }),
  },
}));

vi.mock('@main/db/client', () => ({
  db: {},
}));

vi.mock('./project-settings-storage', () => ({
  ProjectSettingsRepository: vi.fn(function ProjectSettingsRepository() {
    if (!storageMockState.storage) {
      throw new Error('ProjectSettingsRepository test storage was not configured');
    }
    return storageMockState.storage;
  }),
}));

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
  },
}));

describe('ProjectSettingsProvider worktreeDirectory validation', () => {
  const tempDirs: string[] = [];
  const createStorage = (): ProjectSettingsStorage => {
    const rows = new Map<
      string,
      {
        baseProjectSettingsJson: string;
        shareableProjectSettingsJson: string;
        legacyConfigMigratedAt: string | null;
      }
    >();
    return {
      get: async (projectId) => rows.get(projectId),
      insertIfMissing: async (projectId, settings) => {
        if (!rows.has(projectId)) rows.set(projectId, settings);
      },
      update: async (projectId, settings) => {
        rows.set(projectId, { ...rows.get(projectId)!, ...settings });
      },
    };
  };

  beforeEach(() => {
    storageMockState.storage = createStorage();
  });

  afterEach(() => {
    storageMockState.storage = undefined;
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('seeds default preserve patterns when the repo has no shared config', async () => {
    const projectPath = tempProjectPath(tempDirs);

    const provider = makeLocalProvider(projectPath);

    await expect(provider.get()).resolves.toMatchObject({
      preservePatterns: [...DEFAULT_PRESERVE_PATTERNS],
    });
  });

  it('does not seed default preserve patterns when shared config defines preservePatterns', async () => {
    const projectPath = tempProjectPath(tempDirs);
    fs.writeFileSync(
      path.join(projectPath, '.emdash.json'),
      JSON.stringify({ preservePatterns: ['.env.shared'] })
    );

    const provider = makeLocalProvider(projectPath);

    await expect(provider.get()).resolves.not.toHaveProperty('preservePatterns');
  });

  it('migrates shareable settings from a local-only root config', async () => {
    const projectPath = tempProjectPath(tempDirs);
    fs.writeFileSync(
      path.join(projectPath, '.emdash.json'),
      JSON.stringify({
        preservePatterns: ['.env.local'],
        shellSetup: 'nvm use',
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
          teardown: 'pnpm cleanup',
        },
      })
    );

    const git = makeTrackingGit(false);
    const provider = makeLocalProvider(projectPath, { git });

    await expect(provider.get()).resolves.toMatchObject({
      preservePatterns: ['.env.local'],
      shellSetup: 'nvm use',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
        teardown: 'pnpm cleanup',
      },
    });
  });

  it('migrates local-only shareable settings for rows already base-migrated', async () => {
    const projectPath = tempProjectPath(tempDirs);
    fs.writeFileSync(
      path.join(projectPath, '.emdash.json'),
      JSON.stringify({
        shellSetup: 'nvm use',
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
        },
      })
    );
    const row = {
      baseProjectSettingsJson: JSON.stringify({ defaultBranch: 'main' }),
      shareableProjectSettingsJson: '{}',
      legacyConfigMigratedAt: new Date().toISOString(),
    };
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const git = makeTrackingGit(false);
    const provider = makeLocalProvider(projectPath, { git });

    await expect(provider.get()).resolves.toMatchObject({
      shellSetup: 'nvm use',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
      },
    });
    const result = await provider.update({ preservePatterns: [] });
    expect(result.success).toBe(true);
    await expect(provider.get()).resolves.not.toHaveProperty('shellSetup');
    await expect(provider.get()).resolves.not.toHaveProperty('scripts');
  });

  it('keeps cleanly tracked shareable settings file-backed', async () => {
    const projectPath = tempProjectPath(tempDirs);
    fs.writeFileSync(
      path.join(projectPath, '.emdash.json'),
      JSON.stringify({
        shellSetup: 'nvm use',
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
        },
      })
    );

    const git = makeTrackingGit(true);
    const provider = makeLocalProvider(projectPath, { git });

    await expect(provider.get()).resolves.toMatchObject({
      preservePatterns: [...DEFAULT_PRESERVE_PATTERNS],
    });
    await expect(provider.get()).resolves.not.toHaveProperty('shellSetup');
    await expect(provider.get()).resolves.not.toHaveProperty('scripts');
  });

  it('migrates legacy remote setting to baseRemote', async () => {
    const projectPath = tempProjectPath(tempDirs);
    const row = {
      baseProjectSettingsJson: JSON.stringify({ remote: 'upstream' }),
      shareableProjectSettingsJson: '{}',
      legacyConfigMigratedAt: null,
    };
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = makeLocalProvider(projectPath);

    await expect(provider.get()).resolves.toMatchObject({ baseRemote: 'upstream' });
    expect(JSON.parse(row.baseProjectSettingsJson)).toEqual({ baseRemote: 'upstream' });
  });

  it.each<[string, string | null]>([
    ['a selected account', 'github.com:42'],
    ['an explicit null account override', null],
  ])('stores %s as the project GitHub account setting', async (_label, githubAccountId) => {
    const projectPath = tempProjectPath(tempDirs);
    const provider = makeLocalProvider(projectPath);

    const result = await provider.update({
      preservePatterns: [],
      githubAccountId,
    });

    expect(result.success).toBe(true);
    await expect(provider.get()).resolves.toMatchObject({ githubAccountId });
  });

  it('patches the selected GitHub account without replacing other base settings', async () => {
    const projectPath = tempProjectPath(tempDirs);
    const row = {
      baseProjectSettingsJson: JSON.stringify({
        defaultBranch: 'develop',
        baseRemote: 'upstream',
        tmux: true,
      }),
      shareableProjectSettingsJson: JSON.stringify({
        preservePatterns: ['.env.local'],
      }),
      legacyConfigMigratedAt: new Date().toISOString(),
    };
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = makeLocalProvider(projectPath);

    const result = await provider.patch({ githubAccountId: 'github.com:42' });

    expect(result.success).toBe(true);
    expect(JSON.parse(row.baseProjectSettingsJson)).toEqual({
      defaultBranch: 'develop',
      baseRemote: 'upstream',
      githubAccountId: 'github.com:42',
      tmux: true,
    });
    await expect(provider.get()).resolves.toMatchObject({
      defaultBranch: 'develop',
      baseRemote: 'upstream',
      githubAccountId: 'github.com:42',
      preservePatterns: ['.env.local'],
      tmux: true,
    });
  });

  it('retries legacy config migration after a failed attempt', async () => {
    const projectPath = tempProjectPath(tempDirs);
    const row = {
      baseProjectSettingsJson: '{}',
      shareableProjectSettingsJson: '{}',
      legacyConfigMigratedAt: null,
    };
    let updateAttempts = 0;
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        updateAttempts += 1;
        if (updateAttempts === 1) throw new Error('db write failed');
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = makeLocalProvider(projectPath);

    await expect(provider.ensure()).rejects.toThrow('db write failed');
    await expect(provider.ensure()).resolves.toBeUndefined();
    await expect(provider.ensure()).resolves.toBeUndefined();

    expect(updateAttempts).toBe(2);
  });

  it('clears shareable fields without validating base settings', async () => {
    const projectPath = tempProjectPath(tempDirs);
    const row = {
      baseProjectSettingsJson: JSON.stringify({
        worktreeDirectory: path.join(projectPath, 'not-yet-created'),
      }),
      shareableProjectSettingsJson: JSON.stringify({
        preservePatterns: ['.env'],
        scripts: {
          setup: 'pnpm install',
          run: 'pnpm dev',
        },
      }),
      legacyConfigMigratedAt: new Date().toISOString(),
    };
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = makeLocalProvider(projectPath);

    const result = await provider.patch({
      clearShareableFields: ['preservePatterns', 'scripts.run'],
    });

    expect(result.success).toBe(true);
    // gugu #2328: ensure 现在会把 legacy shareable 迁移的收敛标记写进同一 JSON(内部键,
    // schema 读取时剥掉)——断言业务字段之外,只再核标记键本身。
    const { __legacyShareableConfigMigratedAt, ...shareable } = JSON.parse(
      row.shareableProjectSettingsJson
    );
    expect(typeof __legacyShareableConfigMigratedAt).toBe('string');
    expect(shareable).toEqual({
      scripts: {
        setup: 'pnpm install',
      },
    });
  });

  it('converges legacy migration markers when there is nothing to migrate (#2328)', async () => {
    const projectPath = tempProjectPath(tempDirs);
    // 无 legacy .emdash.json、双标记皆缺——旧行为下 shareable 标记永不写入,
    // 每次 mount 都为一个必然 no-op 的迁移重开 worktree lease(SSH 项目 = 远端 RTT)。
    const row = {
      baseProjectSettingsJson: JSON.stringify({}),
      shareableProjectSettingsJson: JSON.stringify({}),
      legacyConfigMigratedAt: null as string | null,
    };
    const settingsStorage: ProjectSettingsStorage = {
      get: async () => row,
      insertIfMissing: vi.fn(),
      update: async (_projectId, settings) => {
        Object.assign(row, settings);
      },
    };
    storageMockState.storage = settingsStorage;
    const provider = makeLocalProvider(projectPath);

    expect(await provider.needsLegacyConfigMigration()).toBe(true);
    await provider.ensure();
    expect(await provider.needsLegacyConfigMigration()).toBe(false);
  });
});
