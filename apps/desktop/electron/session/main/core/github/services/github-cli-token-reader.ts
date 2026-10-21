// gh CLI 是这些账号的**唯一**凭据持有者:咕咕读它、用完即弃,不再抄一份进 app_secrets。
// 抄副本有三个实打实的代价,都在真机上验到过:①写副本要 safeStorage.encryptString → macOS
// 钥匙串,ad-hoc 签名的构建每换一版就被系统重新盘问一次;②副本没有失效同步,gh 那份轮换/过期
// 后库里留着一个 401 的旧 token;③同一份凭据多存一处就多一处要保护。
import type { IExecutionContext } from '@gugu/session-core/exec';
import { normalizeRepositoryHost } from '@shared/repository-ref';

const GITHUB_CLI_AUTH_STATUS_TIMEOUT_MS = 5_000;

/** One authenticated host entry as reported by `gh auth status`. */
export type GitHubCliAccount = {
  host: string;
  login: string;
  token: string;
};

type GitHubCliAuthStatusEntry = {
  state?: unknown;
  host?: unknown;
  login?: unknown;
  token?: unknown;
};

type GitHubCliAuthStatus = {
  hosts?: unknown;
};

function parseCliStatus(raw: string): GitHubCliAuthStatus {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function cliEntries(status: GitHubCliAuthStatus): GitHubCliAuthStatusEntry[] {
  if (typeof status.hosts !== 'object' || status.hosts === null) return [];
  const entries: GitHubCliAuthStatusEntry[] = [];
  for (const [host, rawHostEntries] of Object.entries(status.hosts)) {
    if (!Array.isArray(rawHostEntries)) continue;
    for (const rawEntry of rawHostEntries) {
      if (typeof rawEntry !== 'object' || rawEntry === null) continue;
      entries.push({ ...(rawEntry as GitHubCliAuthStatusEntry), host });
    }
  }
  return entries;
}

/**
 * Reads GitHub tokens straight out of the `gh` CLI at call time.
 *
 * Every read shells out anew: a token that gh has rotated, expired, or logged
 * out of stops working here immediately, with no stale copy of our own to fall
 * back to. `gh` missing or not logged in yields an empty list, never a throw.
 */
export class GitHubCliTokenReader {
  constructor(private readonly ctx: Pick<IExecutionContext, 'exec'>) {}

  /** Every host gh reports as successfully authenticated, with its token. */
  async readAccounts(): Promise<GitHubCliAccount[]> {
    const stdout = await this.readCliStatus();
    if (!stdout) return [];

    const accounts: GitHubCliAccount[] = [];
    for (const entry of cliEntries(parseCliStatus(stdout))) {
      if (entry.state !== 'success') continue;
      if (typeof entry.token !== 'string' || entry.token.trim().length === 0) continue;
      const host = typeof entry.host === 'string' ? normalizeRepositoryHost(entry.host) : '';
      if (!host) continue;

      accounts.push({
        host,
        login: typeof entry.login === 'string' ? entry.login : '',
        token: entry.token.trim(),
      });
    }
    return accounts;
  }

  /**
   * Token for one host, optionally pinned to a login so multi-account setups
   * don't hand back a different user's token. Null when gh has nothing usable.
   */
  async readToken(host: string, login?: string): Promise<string | null> {
    const normalizedHost = normalizeRepositoryHost(host);
    const accounts = await this.readAccounts();
    const wanted = login?.trim();
    const match = wanted
      ? accounts.find((account) => account.host === normalizedHost && account.login === wanted)
      : accounts.find((account) => account.host === normalizedHost);
    return match?.token ?? null;
  }

  private async readCliStatus(): Promise<string | null> {
    try {
      const { stdout } = await this.ctx.exec(
        'gh',
        ['auth', 'status', '--json', 'hosts', '--show-token'],
        {
          timeout: GITHUB_CLI_AUTH_STATUS_TIMEOUT_MS,
        }
      );
      return stdout;
    } catch {
      return null;
    }
  }
}
