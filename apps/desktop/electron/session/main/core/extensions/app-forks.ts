import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { variantNameSchema, type ExtensionVariant } from '@shared/extensions/variants';
import { isGuguOwnApp } from '@shared/extensions/first-run';
import { compareExtensionVersions } from '@shared/extensions/manifest';
import { bundleEntryRejection, type MarketCodeSource } from '@shared/extensions/market';
import { getGitExecutable } from '../utils/exec';
import { reviewGitEnv } from '../runtime/review-git-env';
import { loginShellEnv } from '@main/utils/userEnv';
import { appSourcesRoot, extensionsService } from './extensions-root';
import { cloudExtensionMarket } from './market-catalog-root';
import { packExtensionArchive } from './extension-archive';

const run = promisify(execFile);
const forkRecordSchema = z.object({
  id: z.string(), name: variantNameSchema, base: z.string(),
  source: z.object({ repo: z.string(), path: z.string(), commit: z.string() }),
});
type ForkRecord = z.infer<typeof forkRecordSchema>;

async function git(cwd: string, args: string[], token?: string): Promise<string> {
  const env = reviewGitEnv({ processEnv: process.env, loginShellEnv: loginShellEnv() });
  // Credentials stay in the child environment: never in a URL, Git config on disk, argv or an exception's command.
  if (token) {
    const count = Number(env.GIT_CONFIG_COUNT ?? '0');
    Object.assign(env, {
      GIT_CONFIG_COUNT: String(count + 2), [`GIT_CONFIG_KEY_${count}`]: 'credential.helper', [`GIT_CONFIG_VALUE_${count}`]: '',
      [`GIT_CONFIG_KEY_${count + 1}`]: 'http.https://github.com/.extraheader',
      [`GIT_CONFIG_VALUE_${count + 1}`]: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    });
  }
  try {
    return (await run(getGitExecutable(), args, { cwd, env, maxBuffer: 4 * 1024 * 1024 })).stdout.trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(token ? message.replaceAll(token, '[redacted]').replaceAll(Buffer.from(`x-access-token:${token}`).toString('base64'), '[redacted]') : message);
  }
}

function checkedSource(source: MarketCodeSource): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(source.repo) || !/^[a-f0-9]{40}$/i.test(source.commit) ||
      (source.path !== '.' && bundleEntryRejection(source.path))) {
    throw new Error('The installed App has an invalid market source; ask its publisher to correct the source record.');
  }
}

/** The receipt lives in .git, outside the bundle. Merely copying an App with the same id is never a fork install. */
export function forkOfDirectory(sourceDir: string): (ForkRecord & { root: string }) | null {
  const sources = path.resolve(appSourcesRoot());
  const relative = path.relative(sources, path.resolve(sourceDir));
  if (relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || relative === '..') return null;
  const root = path.join(sources, relative.split(path.sep)[0] ?? '');
  const receipt = path.join(root, '.git', 'gugu-fork.json');
  if (!fs.existsSync(receipt)) return null;
  const record = forkRecordSchema.parse(JSON.parse(fs.readFileSync(receipt, 'utf8')));
  checkedSource(record.source);
  if (path.basename(root) !== `${record.id}@${record.name}` ||
      fs.realpathSync(sourceDir) !== fs.realpathSync(path.join(root, record.source.path))) {
    throw new Error('Install the fork from the source_dir returned by app_create.');
  }
  return { ...record, root };
}

/** Fetch precisely the installed release's source, then give the agent its editable bundle directory. */
export async function createAppFork(id: string, requestedName?: string) {
  const service = extensionsService();
  if (!service.isInstalled(id)) throw new Error(`App ${id} is not installed; use app_install {market:${JSON.stringify(id)}} first.`);
  const installed = service.get(id);
  const origin = service.origins()[id];
  if (origin !== 'market' && origin !== 'fork') throw new Error(`App ${id} is not installed from the market. Install it with app_install {market:${JSON.stringify(id)}} before forking.`);
  const name = variantNameSchema.parse(requestedName ?? 'my-fork');
  if (name === 'upstream') throw new Error('upstream is the original variant; choose another fork name.');
  const state = service.variants(id);
  const current = state.variants.find((entry) => entry.name === state.active);
  const version = current?.base ?? installed.manifest.version;
  const row = await cloudExtensionMarket().sourceVersion(id, version);
  if (!row) throw new Error(`The market no longer has the exact source of ${id}@${version}; ask its publisher to restore that version's source record.`);
  const source = row.source;
  checkedSource(source);
  const root = path.join(appSourcesRoot(), `${id}@${name}`);
  const sourceDir = path.join(root, source.path);
  const branch = isGuguOwnApp(source) ? `fork/${id}/${name}` : `gugu-fork/${name}`;
  const [{ githubAccountService }, { githubApiAuthService }, { getOctokit }] = await Promise.all([
    import('../github/accounts/github-account-service-instance'), import('../github/services/github-api-auth-service-instance'), import('../github/services/octokit-provider'),
  ]);
  const account = (await githubAccountService.listAccounts()).find((entry) => entry.isDefault && entry.host === 'github.com');
  const auth = account ? await githubApiAuthService.getToken('github.com', { accountId: account.accountId }) : null;
  if (auth && !auth.success) throw new Error(`Reconnect GitHub in Settings before forking: ${auth.error.message}`);
  const token = auth?.success ? auth.data : undefined;
  fs.mkdirSync(appSourcesRoot(), { recursive: true });
  const existing = fs.existsSync(root) ? forkOfDirectory(sourceDir) : null;
  if (fs.existsSync(root) && (!existing || existing.id !== id || existing.name !== name)) {
    throw new Error(`The fork folder ${root} already exists; choose another name in app_create {fork_of, name}.`);
  }
  if (!existing) {
    try {
      await git(appSourcesRoot(), ['clone', '--no-checkout', '--origin', 'upstream',
        ...(isGuguOwnApp(source) ? ['--filter=blob:none', '--sparse'] : []), `https://github.com/${source.repo}.git`, root], token);
      if (isGuguOwnApp(source)) await git(root, ['sparse-checkout', 'set', '--', `sources/${id}`], token);
      await git(root, ['fetch', 'upstream', source.commit], token);
      await git(root, ['checkout', '-b', branch, source.commit], token);
      const manifest = service.inspectDirectory(sourceDir).manifest;
      if (manifest.id !== id || manifest.version !== version) throw new Error(`The indexed source does not contain ${id}@${version}; ask the publisher to correct its source record.`);
      const record: ForkRecord = { id, name, base: version, source };
      fs.writeFileSync(path.join(root, '.git', 'gugu-fork.json'), `${JSON.stringify(record)}\n`);
    } catch (error) {
      fs.rmSync(root, { recursive: true, force: true });
      throw new Error(`The exact installed source could not be prepared. Retry app_create with the same fork_of and name after fixing: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  service.retainUpstream(id, { name: 'upstream', base: version, commit: source.commit, repo: source.repo, path: source.path, dir: null, sha256: row.sha256, bytes: row.bytes });
  let repo: string | null = null;
  if (account) {
    try {
      const client = await getOctokit('github.com', { accountId: account.accountId });
      if (!client.success) throw new Error(client.error.message);
      const [owner, repository] = source.repo.split('/') as [string, string];
      repo = `${account.login}/${repository}`;
      if (repo !== source.repo) {
        try {
          const own = await client.data.repos.get({ owner: account.login, repo: repository });
          if (own.data.parent?.full_name !== source.repo && own.data.source?.full_name !== source.repo) throw new Error(`${repo} already exists and is not a fork of ${source.repo}; rename that repository before retrying app_create.`);
        } catch (error) {
          if ((error as { status?: number }).status !== 404) throw error;
          await client.data.repos.createFork({ owner, repo: repository });
          // GitHub forks asynchronously; wait for the exact Git object before pushing (GitHub documents up to 5 min).
          for (let attempt = 0; ; attempt++) {
            try {
              await client.data.git.getCommit({ owner: account.login, repo: repository, commit_sha: source.commit });
              break;
            } catch (error) {
              if (![404, 409].includes((error as { status?: number }).status ?? 0) || attempt >= 60) throw error;
              await delay(5_000);
            }
          }
        }
      }
      const remotes = (await git(root, ['remote'])).split('\n');
      await git(root, ['remote', remotes.includes('origin') ? 'set-url' : 'add', 'origin', `https://github.com/${repo}.git`]);
      await git(root, ['push', '-u', 'origin', branch], token);
    } catch (error) {
      throw new Error(`The local fork is ready at ${sourceDir}, but GitHub setup did not finish. Fix the GitHub error and retry app_create with the same fork_of and name: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { id, name, source_dir: sourceDir, git_dir: root, branch, repo, base: existing?.base ?? version, commit: await git(root, ['rev-parse', 'HEAD']), next: `Edit source_dir, keep the App id and data format, then app_install {source_dir:${JSON.stringify(sourceDir)}} to activate this variant. Read guide apps-fork.` };
}

export async function prepareForkVariant(sourceDir: string): Promise<ExtensionVariant | undefined> {
  const fork = forkOfDirectory(sourceDir);
  if (!fork) return undefined;
  const service = extensionsService();
  const { manifest, bytes, sha256 } = await packExtensionArchive(service, sourceDir);
  if (manifest.id !== fork.id) throw new Error(`Keep the upstream App id ${fork.id} in manifest.json, then retry app_install.`);
  service.get(fork.id);
  const commit = await git(fork.root, ['rev-parse', 'HEAD']);
  // A successful merge of an indexed commit advances the base, regardless of the fork's manifest version.
  const versions = await cloudExtensionMarket().sourceVersions(fork.id);
  let base = fork.base;
  for (const row of versions.filter((entry) => !entry.yanked && entry.source.repo === fork.source.repo && entry.source.path === fork.source.path).sort((a, b) => compareExtensionVersions(a.version, b.version))) {
    if (compareExtensionVersions(row.version, base) > 0 && await git(fork.root, ['merge-base', commit, row.source.commit]).then((common) => common === row.source.commit, () => false)) base = row.version;
  }
  const remotes = (await git(fork.root, ['remote'])).split('\n');
  const remote = remotes.includes('origin') ? await git(fork.root, ['config', '--get', 'remote.origin.url']) : '';
  const repo = /^https:\/\/github.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(remote)?.[1] ?? null;
  return { name: fork.name, base, commit, repo, path: fork.source.path, dir: sourceDir, sha256, bytes: bytes.byteLength };
}
