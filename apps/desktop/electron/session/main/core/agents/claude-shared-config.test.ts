import { lstat, mkdir, mkdtemp, readFile, readlink, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { shareClaudeConfig, type ClaudeSharedConfigPaths } from './claude-shared-config';

let base = '';
let paths: ClaudeSharedConfigPaths;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'gugu-claude-shared-'));
  paths = {
    nativeRoot: join(base, 'user', '.claude'),
    nativeGlobalConfig: join(base, 'user', '.claude.json'),
    connectionRoot: join(base, 'connection', '.claude'),
  };
  await mkdir(join(paths.nativeRoot, 'skills', 'review'), { recursive: true });
  await mkdir(join(paths.nativeRoot, 'plugins', 'synced', 'me'), { recursive: true });
  await writeFile(join(paths.nativeRoot, 'plugins', 'installed_plugins.json'), '{}');
  await writeFile(join(paths.nativeRoot, 'settings.json'), '{"env":{"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE":"50"}}');
  await writeFile(join(paths.nativeRoot, 'CLAUDE.md'), '# mine');
  await writeFile(
    paths.nativeGlobalConfig,
    JSON.stringify({
      oauthAccount: { emailAddress: 'me' },
      mcpServers: { docs: { command: 'docs' } },
      projects: { '/repo': { mcpServers: { local: { command: 'local' } }, hasTrustDialogAccepted: true } },
    })
  );
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

it('links the user configuration, keeps account-scoped content and moves earlier files aside', async () => {
  await mkdir(join(paths.connectionRoot, 'plugins', 'synced', 'work'), { recursive: true });
  await writeFile(join(paths.connectionRoot, 'settings.json'), '{"written":"before the fix"}');
  await writeFile(
    join(paths.connectionRoot, '.claude.json'),
    JSON.stringify({ oauthAccount: { emailAddress: 'work' }, projects: { '/repo': { hasTrustDialogAccepted: false } } })
  );

  await shareClaudeConfig(paths);

  for (const name of ['settings.json', 'CLAUDE.md', join('skills', 'review'), join('plugins', 'installed_plugins.json')]) {
    expect(await readlink(join(paths.connectionRoot, name))).toBe(join(paths.nativeRoot, name));
  }
  expect((await lstat(join(paths.connectionRoot, 'plugins'))).isDirectory()).toBe(true);
  expect(await readdir(join(paths.connectionRoot, 'plugins', 'synced'))).toEqual(['work']);
  expect(await readFile(join(paths.connectionRoot, '.gugu-replaced', 'settings.json'), 'utf8')).toBe('{"written":"before the fix"}');
  expect(JSON.parse(await readFile(join(paths.connectionRoot, '.claude.json'), 'utf8'))).toEqual({
    oauthAccount: { emailAddress: 'work' },
    mcpServers: { docs: { command: 'docs' } },
    projects: { '/repo': { hasTrustDialogAccepted: false, mcpServers: { local: { command: 'local' } } } },
  });
});

it('follows later changes: removed user entries and MCP servers disappear, repeated runs are stable', async () => {
  await shareClaudeConfig(paths);
  await rm(join(paths.nativeRoot, 'CLAUDE.md'));
  await writeFile(paths.nativeGlobalConfig, JSON.stringify({ oauthAccount: { emailAddress: 'me' } }));
  await shareClaudeConfig(paths);
  await shareClaudeConfig(paths);
  await expect(lstat(join(paths.connectionRoot, 'CLAUDE.md'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readlink(join(paths.connectionRoot, 'settings.json'))).toBe(join(paths.nativeRoot, 'settings.json'));
  expect(JSON.parse(await readFile(join(paths.connectionRoot, '.claude.json'), 'utf8'))).toEqual({});
  await expect(lstat(join(paths.connectionRoot, '.gugu-replaced'))).rejects.toMatchObject({ code: 'ENOENT' });
});
