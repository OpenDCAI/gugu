import type { IFileSystem } from '@gugu/session-core/files';
import { ok } from '@gugu/session-shared';
import { describe, expect, it, vi } from 'vitest';
import { getEffectiveSessionSettings } from './effective-session-settings';
import type { ProjectSettingsProvider } from './provider';

function makeProjectSettings(settings: Awaited<ReturnType<ProjectSettingsProvider['get']>>) {
  return {
    get: vi.fn().mockResolvedValue(settings),
  } as unknown as ProjectSettingsProvider;
}

function makeSessionFs(config: unknown | null): Pick<IFileSystem, 'exists' | 'readText'> {
  return {
    exists: vi.fn(async () => ok(config !== null)),
    readText: vi.fn(async () =>
      ok({
        content: JSON.stringify(config),
        truncated: false,
        totalSize: 0,
      })
    ),
  };
}

describe('getEffectiveSessionSettings', () => {
  const sessionConfigPath = '/worktree/.emdash.json';

  it('merges shareable project settings by leaf with project settings winning', async () => {
    const sessionFs = makeSessionFs({
      scripts: { setup: 'pnpm install', run: 'npm run dev' },
      shellSetup: 'source .envrc',
      tmux: true,
      remote: 'upstream',
    });
    const settings = await getEffectiveSessionSettings({
      projectSettings: makeProjectSettings({
        preservePatterns: ['.env.local'],
        scripts: { run: 'pnpm dev' },
      }),
      sessionFs,
      sessionConfigPath,
    });

    expect(sessionFs.exists).toHaveBeenCalledWith(sessionConfigPath);
    expect(sessionFs.readText).toHaveBeenCalledWith(sessionConfigPath);
    expect(settings).toMatchObject({
      preservePatterns: ['.env.local'],
      shellSetup: 'source .envrc',
      scripts: {
        setup: 'pnpm install',
        run: 'pnpm dev',
      },
    });
    expect(settings).not.toHaveProperty('tmux');
    expect(settings).not.toHaveProperty('remote');
    expect(settings).not.toHaveProperty('baseRemote');
  });

  it('falls back to defaults plus project settings when the task config is invalid', async () => {
    const settings = await getEffectiveSessionSettings({
      projectSettings: makeProjectSettings({ shellSetup: 'nvm use' }),
      sessionFs: {
        exists: vi.fn(async () => ok(true)),
        readText: vi.fn(async () => ok({ content: '{', truncated: false, totalSize: 1 })),
      },
      sessionConfigPath,
    });

    expect(settings.preservePatterns).toContain('.env');
    expect(settings.preservePatterns).not.toContain('.emdash.json');
    expect(settings.shellSetup).toBe('nvm use');
  });

  it('falls back to project settings when the task config read is truncated', async () => {
    const settings = await getEffectiveSessionSettings({
      projectSettings: makeProjectSettings({
        scripts: { run: 'pnpm dev' },
      }),
      sessionFs: {
        exists: vi.fn(async () => ok(true)),
        readText: vi.fn(async () =>
          ok({ content: '{"scripts":', truncated: true, totalSize: 204_801 })
        ),
      },
      sessionConfigPath,
    });

    expect(settings.scripts?.run).toBe('pnpm dev');
  });

  it('falls back to defaults when project settings are invalid', async () => {
    const settings = await getEffectiveSessionSettings({
      projectSettings: makeProjectSettings({
        preservePatterns: 'not-an-array',
      } as never),
      sessionFs: makeSessionFs(null),
      sessionConfigPath,
    });

    expect(settings.preservePatterns).toContain('.env');
  });
});
