import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { ExtensionsService } from './extensions-service';
import type { MarketIndexVersion } from '@shared/extensions/market';

const state = vi.hoisted(() => ({ work: '', repo: '', service: null as unknown as ExtensionsService, rows: [] as MarketIndexVersion[], connected: false, forkExists: false, createForks: 0 }));
vi.mock('./extensions-root', () => ({ extensionsService: () => state.service, appSourcesRoot: () => path.join(state.work, 'app-sources') }));
vi.mock('./market-catalog-root', () => ({ cloudExtensionMarket: () => ({ sourceVersion: async (_id: string, version: string) => state.rows.find((row) => row.version === version), sourceVersions: async () => state.rows }) }));
vi.mock('../github/accounts/github-account-service-instance', () => ({ githubAccountService: { listAccounts: async () => state.connected ? [{ accountId: 'account', host: 'github.com', login: 'my-user', isDefault: true }] : [] } }));
vi.mock('../github/services/github-api-auth-service-instance', () => ({ githubApiAuthService: { getToken: async () => ({ success: true, data: 'unit-test-token' }) } }));
vi.mock('../github/services/octokit-provider', () => ({ getOctokit: async () => ({ success: true, data: { repos: { get: async () => { if (!state.forkExists) throw Object.assign(new Error('Not found'), { status: 404 }); return { data: { parent: { full_name: 'shuxueshuxue/gugu-apps' } } }; }, createFork: async () => { state.forkExists = true; state.createForks++; } } } }) }));
vi.mock('../utils/exec', () => ({ getGitExecutable: () => 'git' }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => null }));
vi.mock('../runtime/review-git-env', () => ({ reviewGitEnv: () => ({ ...process.env, GIT_CONFIG_COUNT: '3', GIT_CONFIG_KEY_2: `url.file://${state.work}/github-fork.git.insteadOf`, GIT_CONFIG_VALUE_2: 'https://github.com/my-user/gugu-apps.git', GIT_CONFIG_KEY_0: `url.file://${state.repo}.insteadOf`, GIT_CONFIG_VALUE_0: 'https://github.com/shuxueshuxue/gugu-apps.git', GIT_CONFIG_KEY_1: 'protocol.file.allow', GIT_CONFIG_VALUE_1: 'always' }) }));
const { createAppFork, prepareForkVariant } = await import('./app-forks');

const git = (...args: string[]) => execFileSync('git', args, { cwd: state.repo, encoding: 'utf8' }).trim();
beforeEach(() => {
  state.connected = false; state.forkExists = false; state.createForks = 0;
  state.work = mkdtempSync(path.join(tmpdir(), 'gugu-fork-source-'));
  state.repo = path.join(state.work, 'upstream');
  mkdirSync(state.repo);
  git('init', '-q');
  git('config', 'user.name', 'App author');
  git('config', 'user.email', 'app@example.com');
  const source = path.join(state.repo, 'sources', 'demo');
  mkdirSync(source, { recursive: true });
  writeFileSync(path.join(source, 'manifest.json'), JSON.stringify({ id: 'demo', name: 'Demo', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, platforms: ['desktop'], entry: 'index.html', contributes: { tabs: [{ name: 'main', title: 'Demo' }] } }));
  writeFileSync(path.join(source, 'index.html'), 'installed release');
  mkdirSync(path.join(state.repo, 'sources', 'other'));
  writeFileSync(path.join(state.repo, 'sources', 'other', 'private.html'), 'not part of this App');
  git('add', '.');
  git('commit', '-qm', 'Original release');
  const commit = git('rev-parse', 'HEAD');
  state.rows = [{ version: '1.0.0', source: { repo: 'shuxueshuxue/gugu-apps', path: 'sources/demo', commit }, sha256: 'a'.repeat(64), bytes: 42, yanked: null } as MarketIndexVersion];
  state.service = new ExtensionsService(path.join(state.work, 'task-extensions'));
  state.service.installFromDirectory(source, state.service.inspectDirectory(source).manifestDigest, 'market');
  // The default branch is now newer; a fork must still start from the installed release's commit.
  writeFileSync(path.join(source, 'index.html'), 'uninstalled newer code');
  git('add', '.');
  git('commit', '-qm', 'Newer code');
});
afterEach(() => rmSync(state.work, { recursive: true, force: true }));

it('forks the exact installed commit, sparse-checks only its App, and installs edited code under the original identity', async () => {
  const fork = await createAppFork('demo', 'my-fix');
  expect(fork.commit).toBe(state.rows[0]!.source.commit);
  expect(fork.branch).toBe('fork/demo/my-fix');
  expect(fork.repo).toBeNull();
  expect(readFileSync(path.join(fork.source_dir, 'index.html'), 'utf8')).toBe('installed release');
  expect(existsSync(path.join(fork.git_dir, 'sources', 'other'))).toBe(false);
  expect(execFileSync('git', ['remote', 'get-url', 'upstream'], { cwd: fork.git_dir, encoding: 'utf8' }).trim()).toBe('https://github.com/shuxueshuxue/gugu-apps.git');
  writeFileSync(path.join(fork.source_dir, 'index.html'), 'my fix');
  const variant = await prepareForkVariant(fork.source_dir);
  expect(variant).toMatchObject({ name: 'my-fix', base: '1.0.0', commit: fork.commit, dir: fork.source_dir });
  const installed = state.service.installFromDirectory(fork.source_dir, state.service.inspectDirectory(fork.source_dir).manifestDigest, 'fork', { id: 'gugu' }, variant);
  expect(readFileSync(path.join(installed.rootDir, 'index.html'), 'utf8')).toBe('my fix');
  expect(state.service.identityOf('demo')).toEqual({ id: 'demo', publisher: 'gugu' });
  expect(state.service.variants('demo').active).toBe('my-fix');
  expect((await createAppFork('demo', 'my-fix')).source_dir).toBe(fork.source_dir);
  expect(readFileSync(path.join(fork.source_dir, 'index.html'), 'utf8')).toBe('my fix');
});

it('rejects an id change instead of replacing another App', async () => {
  const fork = await createAppFork('demo');
  const manifestFile = path.join(fork.source_dir, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as { id: string };
  manifest.id = 'other';
  writeFileSync(manifestFile, JSON.stringify(manifest));
  await expect(prepareForkVariant(fork.source_dir)).rejects.toThrow('Keep the upstream App id demo');
  expect(state.service.variants('demo').active).toBe('upstream');
});


it('reuses the connected GitHub account, creates one repository fork and pushes separate App branches', async () => {
  state.connected = true;
  const bare = path.join(state.work, 'github-fork.git');
  git('clone', '--bare', '-q', state.repo, bare);
  const first = await createAppFork('demo', 'first');
  const second = await createAppFork('demo', 'second');
  expect(first.repo).toBe('my-user/gugu-apps');
  expect(state.createForks).toBe(1);
  for (const fork of [first, second]) {
    expect(execFileSync('git', ['--git-dir', bare, 'rev-parse', `refs/heads/${fork.branch}`], { encoding: 'utf8' }).trim()).toBe(fork.commit);
    expect(readFileSync(path.join(fork.git_dir, '.git', 'config'), 'utf8')).not.toContain('unit-test-token');
  }
});
