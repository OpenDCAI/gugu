import type { PluginFs } from '@gugu/session-core/agents/plugins';
import { parse } from 'jsonc-parser';
import { describe, expect, it, vi } from 'vitest';
import { provider } from './index';

function configFileTrust() {
  const trust = provider.behavior.trust;
  if (trust?.channel !== 'config-file') {
    throw new Error(`expected a config-file trust behavior, got ${String(trust?.channel)}`);
  }
  return trust;
}

function createMemoryFs(initial: Record<string, string> = {}): PluginFs & {
  files: Map<string, string>;
  writes: Array<{ path: string; content: string }>;
} {
  const files = new Map(Object.entries(initial));
  const writes: Array<{ path: string; content: string }> = [];

  return {
    files,
    writes,
    read: async (path) => files.get(path) ?? null,
    write: vi.fn(async (path, content) => {
      writes.push({ path, content });
      files.set(path, content);
    }),
    delete: async (path) => {
      files.delete(path);
    },
    exists: async (path) => files.has(path),
    list: async () => [],
  };
}

describe('Copilot trust behavior', () => {
  it('adds trusted folders while preserving existing entries', async () => {
    const fs = createMemoryFs({
      '.copilot/config.json': JSON.stringify({ trustedFolders: ['/already/trusted'] }),
    });

    await configFileTrust().trustWorkspace(fs, { workspacePath: '/tmp/worktree' });

    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0].path).toBe('.copilot/config.json');
    expect(JSON.parse(fs.writes[0].content).trustedFolders).toEqual([
      '/already/trusted',
      '/tmp/worktree',
    ]);
  });

  it('does not rewrite when the folder is already trusted', async () => {
    const fs = createMemoryFs({
      '.copilot/config.json': JSON.stringify({ trustedFolders: ['/tmp/worktree'] }),
    });

    await configFileTrust().trustWorkspace(fs, { workspacePath: '/tmp/worktree' });

    expect(fs.writes).toHaveLength(0);
  });

  it('reads JSONC and preserves Copilot comments when adding a trusted folder', async () => {
    const fs = createMemoryFs({
      '.copilot/config.json':
        '// User settings belong in settings.json.\n' +
        '// This file is managed automatically.\n' +
        '{\n  "trustedFolders": []\n}\n',
    });

    await configFileTrust().trustWorkspace(fs, { workspacePath: '/tmp/worktree' });

    const output = fs.files.get('.copilot/config.json')!;
    expect(output).toContain('// User settings belong in settings.json.');
    expect(output).toContain('// This file is managed automatically.');
    expect(parse(output).trustedFolders).toEqual(['/tmp/worktree']);
  });

  it('refuses to overwrite a genuinely unreadable JSONC config', async () => {
    const original = '{{{';
    const fs = createMemoryFs({ '.copilot/config.json': original });

    await expect(
      configFileTrust().trustWorkspace(fs, { workspacePath: '/tmp/worktree' })
    ).rejects.toThrow(/refusing to overwrite unreadable JSONC config \.copilot\/config\.json/);

    expect(fs.writes).toHaveLength(0);
    expect(fs.files.get('.copilot/config.json')).toBe(original);
  });
});
