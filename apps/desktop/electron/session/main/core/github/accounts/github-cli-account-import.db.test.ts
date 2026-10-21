import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IExecutionContext } from '@gugu/session-core/exec';
import type { GitHubUser } from '@shared/github';
import { GitHubCliTokenReader } from '../services/github-cli-token-reader';
import { GITHUB_PROVIDER_ID, upsertGitHubAccount } from './github-accounts';
import { GitHubCliAccountImportService } from './github-cli-account-import';

function makeGitHubUser(id: number, login: string): GitHubUser {
  return {
    id,
    login,
    name: login,
    email: '',
    avatar_url: `https://avatars.githubusercontent.com/u/${id}`,
  };
}

function makeCtx(stdout: string): Pick<IExecutionContext, 'exec'> {
  return {
    exec: vi.fn().mockResolvedValue({ stdout, stderr: '' }),
  };
}

describe('GitHubCliAccountImportService', () => {
  let fixture: RegistryFixture;
  let usersByToken: Map<string, GitHubUser>;
  let getAuthenticatedUser: ReturnType<
    typeof vi.fn<(token: string, host?: string) => Promise<GitHubUser | null>>
  >;

  beforeEach(async () => {
    fixture = await openRegistryFixture('empty');
    usersByToken = new Map([
      ['gho_monalisa', makeGitHubUser(42, 'monalisa')],
      ['gho_octocat', makeGitHubUser(84, 'octocat')],
      ['ghes_enterprise', makeGitHubUser(168, 'enterprise')],
    ]);
    getAuthenticatedUser = vi.fn<(token: string, host?: string) => Promise<GitHubUser | null>>(
      async (token: string) => usersByToken.get(token) ?? null
    );
  });

  afterEach(() => {
    fixture?.close();
  });

  function makeService(stdout: string) {
    return new GitHubCliAccountImportService(
      fixture.registry,
      new GitHubCliTokenReader(makeCtx(stdout)),
      { getAuthenticatedUser }
    );
  }

  it('imports every GitHub.com account reported by GitHub CLI as linked accounts', async () => {
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
            {
              state: 'success',
              active: false,
              host: 'github.com',
              login: 'octocat',
              token: 'gho_octocat',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts();

    expect(imported.map((account) => account.id)).toEqual(['github.com:42', 'github.com:84']);
    await expect(fixture.registry.getDefaultAccountId(GITHUB_PROVIDER_ID)).resolves.toBe(
      'github.com:42'
    );
  });

  it('registers gh accounts without copying their tokens into the encrypted store', async () => {
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await service.importAccounts();

    // gh stays the only holder: identity is registered, the secret never is.
    await expect(
      fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:42')
    ).resolves.toBeNull();
    await expect(fixture.registry.listAccounts(GITHUB_PROVIDER_ID)).resolves.toHaveLength(1);
  });

  it('clears a token an older build had copied for the same account', async () => {
    await upsertGitHubAccount(fixture.registry, {
      accessToken: 'gho_monalisa',
      credentialSource: 'cli',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });
    await expect(
      fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:42')
    ).resolves.toBe('gho_monalisa');

    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await service.importAccounts();

    await expect(
      fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:42')
    ).resolves.toBeNull();
  });

  it('leaves a device-flow account alone when gh is logged in as the same user', async () => {
    // Account ids are `${host}:${userId}` — they say nothing about how the account
    // was authenticated. So an in-app device-flow login and a gh login for the same
    // GitHub user land on the same row, and reconcile runs the CLI import last.
    // Claiming that row for gh would delete the only copy of the device-flow token
    // and leave the user with nothing the moment gh logs out.
    await upsertGitHubAccount(fixture.registry, {
      accessToken: 'gho_device_flow',
      credentialSource: 'device_flow',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });

    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await expect(service.importAccounts()).resolves.toMatchObject([
      { id: 'github.com:42', credentialSource: 'device_flow' },
    ]);
    await expect(
      fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:42')
    ).resolves.toBe('gho_device_flow');
  });

  it('bounds the GitHub CLI status call so startup cannot hang indefinitely', async () => {
    const ctx = makeCtx(JSON.stringify({ hosts: {} }));
    const service = new GitHubCliAccountImportService(
      fixture.registry,
      new GitHubCliTokenReader(ctx),
      { getAuthenticatedUser }
    );

    await service.importAccounts();

    expect(ctx.exec).toHaveBeenCalledWith(
      'gh',
      ['auth', 'status', '--json', 'hosts', '--show-token'],
      { timeout: 5_000 }
    );
  });

  it('keeps existing linked accounts that are no longer reported by GitHub CLI', async () => {
    await upsertGitHubAccount(fixture.registry, {
      accessToken: 'gho_existing',
      credentialSource: 'cli',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '168',
        host: 'github.com',
        login: 'hubot',
        avatarUrl: '',
      },
    });

    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await service.importAccounts();

    await expect(fixture.registry.listAccounts(GITHUB_PROVIDER_ID)).resolves.toHaveLength(2);
    await expect(
      fixture.registry.resolveSecret(GITHUB_PROVIDER_ID, 'github.com:168')
    ).resolves.toBe('gho_existing');
  });

  it('ignores CLI entries that cannot be resolved to a GitHub user', async () => {
    usersByToken.delete('gho_octocat');
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
            {
              state: 'success',
              active: false,
              host: 'github.com',
              login: 'octocat',
              token: 'gho_octocat',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts();

    expect(imported.map((account) => account.id)).toEqual(['github.com:42']);
    await expect(fixture.registry.listAccounts(GITHUB_PROVIDER_ID)).resolves.toHaveLength(1);
  });

  it('imports GitHub Enterprise accounts reported by GitHub CLI', async () => {
    const service = makeService(
      JSON.stringify({
        hosts: {
          'ghe.example.com': [
            {
              state: 'success',
              active: true,
              host: 'ghe.example.com',
              login: 'enterprise',
              token: 'ghes_enterprise',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts();

    expect(imported.map((account) => account.id)).toEqual(['ghe.example.com:168']);
    expect(getAuthenticatedUser).toHaveBeenCalledWith('ghes_enterprise', 'ghe.example.com');
  });

  it('uses the CLI hosts map key as the authoritative account host', async () => {
    const service = makeService(
      JSON.stringify({
        hosts: {
          'ghe.example.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'enterprise',
              token: 'ghes_enterprise',
            },
          ],
        },
      })
    );

    const imported = await service.importAccounts();

    expect(imported.map((account) => account.id)).toEqual(['ghe.example.com:168']);
    expect(getAuthenticatedUser).toHaveBeenCalledWith('ghes_enterprise', 'ghe.example.com');
  });

  it('re-imports previously removed CLI accounts that are still logged in to gh', async () => {
    const { account } = await upsertGitHubAccount(fixture.registry, {
      accessToken: 'gho_monalisa',
      credentialSource: 'cli',
      providerAccount: {
        providerId: 'github',
        providerAccountId: '42',
        host: 'github.com',
        login: 'monalisa',
        avatarUrl: '',
      },
    });
    await fixture.registry.removeAccount(GITHUB_PROVIDER_ID, account.id);
    const service = makeService(
      JSON.stringify({
        hosts: {
          'github.com': [
            {
              state: 'success',
              active: true,
              host: 'github.com',
              login: 'monalisa',
              token: 'gho_monalisa',
            },
          ],
        },
      })
    );

    await expect(service.importAccounts()).resolves.toMatchObject([
      { id: 'github.com:42', credentialSource: 'cli' },
    ]);
    await expect(fixture.registry.listAccounts(GITHUB_PROVIDER_ID)).resolves.toHaveLength(1);
  });
});
