import { err, ok, type Result } from '@gugu/session-shared';
import { normalizeRepositoryHost } from '@shared/repository-ref';
import {
  GITHUB_PROVIDER_ID,
  toGitHubAccount,
  type GitHubAccount,
  type GitHubAccountStore,
} from '../accounts/github-accounts';
import {
  githubApiAccountHostMismatch,
  githubApiAccountNotFound,
  githubApiAuthRequired,
  githubApiTokenMissing,
  type GitHubApiAuthError,
} from './github-api-auth-errors';

export type GitHubApiAuthContext = {
  accountId?: string;
};

type GitHubAccountLookup = Pick<
  GitHubAccountStore,
  'getDefaultAccountId' | 'listAccounts' | 'resolveSecret'
>;

type GitHubCliTokenLookup = {
  readToken(host: string, login?: string): Promise<string | null>;
};

export class GitHubApiAuthService {
  constructor(
    private readonly accountLookup: GitHubAccountLookup,
    private readonly cliTokenLookup: GitHubCliTokenLookup
  ) {}

  async getToken(
    host: string,
    context: GitHubApiAuthContext = {}
  ): Promise<Result<string, GitHubApiAuthError>> {
    const normalizedHost = normalizeRepositoryHost(host);
    const accountId = context.accountId?.trim() || null;
    const account = await this.resolveAccount(normalizedHost, accountId);
    if (!account) return err(githubApiAuthRequired(normalizedHost));
    if (!account.success) return err(account.error);

    const token = await this.resolveToken(account.data);
    if (!token) return err(githubApiTokenMissing(normalizedHost, account.data.id));
    return ok(token);
  }

  /**
   * gh-sourced accounts hold no local copy: ask gh each time, so a token it has
   * rotated or logged out of fails here immediately instead of silently using a
   * stale one. Every other source resolves from the encrypted store as before.
   */
  private async resolveToken(account: GitHubAccount): Promise<string | null> {
    if (account.credentialSource === 'cli') {
      return this.cliTokenLookup.readToken(account.host, account.login || undefined);
    }
    return this.accountLookup.resolveSecret(GITHUB_PROVIDER_ID, account.id);
  }

  private async resolveAccount(
    normalizedHost: string,
    accountId: string | null
  ): Promise<Result<GitHubAccount, GitHubApiAuthError> | null> {
    const accounts = (await this.accountLookup.listAccounts(GITHUB_PROVIDER_ID)).map(
      toGitHubAccount
    );
    if (accountId) {
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account) return err(githubApiAccountNotFound(normalizedHost, accountId));

      const accountHost = normalizeRepositoryHost(account.host);
      if (accountHost !== normalizedHost) {
        return err(githubApiAccountHostMismatch(normalizedHost, account.id, accountHost));
      }

      return ok(account);
    }

    const defaultAccountId = await this.accountLookup.getDefaultAccountId(GITHUB_PROVIDER_ID);
    if (!defaultAccountId) return null;

    const defaultAccount =
      accounts.find(
        (candidate) =>
          candidate.id === defaultAccountId &&
          normalizeRepositoryHost(candidate.host) === normalizedHost
      ) ?? null;
    return defaultAccount ? ok(defaultAccount) : null;
  }
}
