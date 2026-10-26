import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ensureCliTool, installedCliTool, isCliToolInstalled } from './cli-tool-installer';
import { cliToolRecipe, currentCliPlatform } from './cli-tools';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'gugu-cli-preinstalled-'));
  vi.stubEnv('GUGU_HOME', path.join(root, 'account'));
  vi.stubEnv('GUGU_CLOUD_COMPUTER', '1');
  vi.stubEnv('GUGU_CLI_PREINSTALL_ROOT', path.join(root, 'runtime'));
});
afterEach(async () => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); await rm(root, { recursive: true, force: true }); });
async function preload(version = cliToolRecipe('lark-cli').version) {
  const dir = path.join(root, 'runtime', 'lark-cli', version);
  await mkdir(path.join(dir, 'bin'), { recursive: true });
  await mkdir(path.join(dir, 'skills', 'lark-shared'), { recursive: true });
  await writeFile(path.join(dir, 'bin', 'lark-cli'), '#!/bin/sh\necho preinstalled\n', { mode: 0o755 });
  await writeFile(path.join(dir, 'skills', 'lark-shared', 'SKILL.md'), 'Shared CLI instructions');
  await writeFile(path.join(dir, '.complete'), version + '\n');
  await writeFile(path.join(dir, '.platform'), currentCliPlatform() + '\n');
  return dir;
}
it('uses the exact runtime binary and Skills through the connection installer without downloading or sharing credentials', async () => {
  const dir = await preload();
  const fetch = vi.fn(() => { throw new Error('No network expected'); }); vi.stubGlobal('fetch', fetch);
  const tool = await ensureCliTool('lark-cli');
  expect(tool.binPath).toBe(path.join(dir, 'bin', 'lark-cli'));
  expect(tool.skillsDir).toBe(path.join(dir, 'skills'));
  expect(tool.homeDir).toBe(path.join(root, 'account', 'integration-tools', 'lark-cli', 'home'));
  expect(isCliToolInstalled('lark-cli')).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
});
it('retains an existing account-local installation and its credential location', async () => {
  await preload();
  const dir = path.join(root, 'account', 'integration-tools', 'lark-cli', cliToolRecipe('lark-cli').version);
  await mkdir(dir, { recursive: true }); await writeFile(path.join(dir, '.complete'), 'existing');
  expect(installedCliTool('lark-cli').binPath).toBe(path.join(dir, 'bin', 'lark-cli'));
});
it('ignores a preinstall on an ordinary local computer', async () => {
  await preload(); vi.stubEnv('GUGU_CLOUD_COMPUTER', '0');
  expect(isCliToolInstalled('lark-cli')).toBe(false);
});
it('does not accept another version', async () => { await preload('0.0.1'); expect(isCliToolInstalled('lark-cli')).toBe(false); });
it('does not accept an incomplete preload or an executable for another platform', async () => {
  const dir = await preload(); await rm(path.join(dir, '.complete'));
  expect(isCliToolInstalled('lark-cli')).toBe(false);
  await writeFile(path.join(dir, '.complete'), cliToolRecipe('lark-cli').version);
  await writeFile(path.join(dir, '.platform'), 'unsupported-platform');
  expect(isCliToolInstalled('lark-cli')).toBe(false);
});
it('does not accept a missing executable', async () => {
  const dir = await preload(); await rm(path.join(dir, 'bin', 'lark-cli'));
  expect(isCliToolInstalled('lark-cli')).toBe(false);
});
