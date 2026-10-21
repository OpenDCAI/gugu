import type { GitHubUser } from '@shared/github';
import type { GitHubCliTokenReader } from '../services/github-cli-token-reader';
import {
  GITHUB_PROVIDER_ID,
  normalizeGitHubHost,
  toGitHubAccount,
  upsertGitHubAccount,
  type GitHubAccount,
  type GitHubAccountStore,
} from './github-accounts';

type GitHubIdentityClient = {
  getAuthenticatedUser(token: string, host?: string): Promise<GitHubUser | null>;
};

type CliAccountStore = Pick<GitHubAccountStore, 'upsertAccount' | 'getAccount' | 'clearSecret'>;

/**
 * Registers the accounts `gh` is logged into, **identity only**.
 *
 * The token is read to resolve the identity and then dropped; gh stays the sole
 * holder and `GitHubApiAuthService` asks it again at call time. Any token this
 * account left in the encrypted store from an earlier build is cleared here, so
 * a machine that upgrades into this behaviour stops carrying a stale copy.
 */
export class GitHubCliAccountImportService {
  constructor(
    private readonly accountStore: CliAccountStore,
    private readonly tokenReader: GitHubCliTokenReader,
    private readonly identityClient: GitHubIdentityClient
  ) {}

  async importAccounts(): Promise<GitHubAccount[]> {
    const cliAccounts = await this.tokenReader.readAccounts();

    const imported: GitHubAccount[] = [];
    for (const cliAccount of cliAccounts) {
      const user = await this.identityClient.getAuthenticatedUser(cliAccount.token, cliAccount.host);
      if (!user) continue;

      // An account id is just `${host}:${userId}` — it does not encode how the
      // account was authenticated. So the same row can already belong to a
      // source that owns its own token (device flow, legacy backfill). Claiming
      // it for gh would flip credentialSource and delete that token, leaving the
      // user with nothing once gh logs out. gh owns only what gh registered.
      const existing = await this.accountStore.getAccount(
        GITHUB_PROVIDER_ID,
        `${normalizeGitHubHost(cliAccount.host)}:${String(user.id)}`
      );
      if (existing && toGitHubAccount(existing).credentialSource !== 'cli') {
        imported.push(toGitHubAccount(existing));
        continue;
      }

      const { account } = await upsertGitHubAccount(this.accountStore, {
        credentialSource: 'cli',
        providerAccount: {
          providerId: 'github',
          providerAccountId: String(user.id),
          host: cliAccount.host,
          login: user.login,
          avatarUrl: user.avatar_url,
        },
      });
      // Drop any ciphertext an older build wrote for this account. deleteSecret
      // only removes the row — it never decrypts, so this stays off the keychain.
      await this.accountStore.clearSecret('github', account.id);
      imported.push(account);
    }
    return imported;
  }
}
