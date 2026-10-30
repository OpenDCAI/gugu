import type { IntegrationCredentials } from '@gugu/session-plugins/integrations';
import { PLATFORM_CREDENTIAL_SOURCE, REJECTED_KEY_SOURCE } from '@shared/core/provider-accounts/provider-account-meta';
import type {
  ProviderAccount,
  ProviderAccountRegistry,
} from '@main/core/provider-accounts/provider-account-registry';

const LEGACY_SECRET_KEYS = {
  linear: 'emdash-linear-token',
  jira: 'emdash-jira-token',
  gitlab: 'emdash-gitlab-token',
  forgejo: 'emdash-forgejo-token',
  plane: 'emdash-plane-token',
  plain: 'emdash-plain-token',
  featurebase: 'emdash-featurebase-token',
  asana: 'emdash-asana-token',
  monday: 'emdash-monday-credentials',
  trello: 'emdash-trello-credentials',
} as const;

/** Account id used by single-account integrations. */
export const DEFAULT_INTEGRATION_ACCOUNT_ID = 'default';

export type IntegrationAccountRecord = {
  accountId: string;
  displayName?: string;
  credentials: IntegrationCredentials;
};

/** 一个已存账号连同它什么时候连上的(资源库详情「连接时间」)。 */
export type StoredIntegrationAccount = IntegrationAccountRecord & { connectedAt: number; isDefault: boolean };

type IntegrationAccountStore = Pick<
  ProviderAccountRegistry,
  | 'listAccounts'
  | 'getAccount'
  | 'setDefaultAccount'
  | 'upsertAccount'
  | 'resolveSecret'
  | 'removeAccount'
  | 'removeAllAccounts'
  | 'isConfigured'
>;

type LegacySecretStore = {
  getSecret(key: string): Promise<string | null>;
  deleteSecret(key: string): Promise<void>;
};

type LegacyKvStore = {
  get(key: string): Promise<Record<string, unknown> | null>;
  del(key: string): Promise<void>;
};

/** Legacy storage locations written by released builds before provider_accounts. */
export type IntegrationLegacyStores = {
  secrets: LegacySecretStore;
  kv: {
    jira: LegacyKvStore;
    gitlab: LegacyKvStore;
    forgejo: LegacyKvStore;
    plane: LegacyKvStore;
  };
};

type WarnLogger = {
  warn(message: string, context: Record<string, unknown>): void;
};

function readString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * Integration credentials on top of the provider account registry: one
 * `provider_accounts` row per connected account, the credential bag stored as
 * JSON behind the row's credentialRef. Single-account integrations use the
 * 'default' account id. Legacy flat-key credentials from released builds are
 * migrated into the registry on first read.
 */
export class IntegrationCredentialStore {
  /** Integrations whose legacy stores were checked (hit or genuine miss). */
  private readonly legacyChecked = new Set<string>();

  constructor(
    private readonly accounts: IntegrationAccountStore,
    private readonly legacy: IntegrationLegacyStores,
    private readonly logger: WarnLogger
  ) {}

  /**
   * Resolve one account: by id when given, otherwise the integration's
   * default account.
   */
  async getAccount(
    integrationId: string,
    accountId?: string
  ): Promise<IntegrationAccountRecord | null> {
    await this.migrateLegacyOnce(integrationId);
    const account = await this.accounts.getAccount(integrationId, accountId);
    if (!account) return null;
    if (keptByPlatform(account)) return toIntegrationAccount(account, {});

    const raw = await this.accounts.resolveSecret(integrationId, account.accountId);
    const credentials = raw ? parseJson(raw) : null;
    if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) return null;

    return toIntegrationAccount(account, credentials as IntegrationCredentials);
  }

  /** #7240 这一家存着的每个账号(多账号:邮箱一个地址一个),按连上的先后。凭据读不出来的那一个跳过不给。 */
  async listAccounts(integrationId: string): Promise<StoredIntegrationAccount[]> {
    return (await this.listAccountsDetailed(integrationId)).accounts;
  }

  /**
   * 同 `listAccounts`,另把「有这条记录、凭据却读不出来」的账号 id 一并交出:想知道「这一家到底存了几个」的人
   * (搬家要把没带走的说清楚)不能只数读得出来的 —— 读不出来的在 `listAccounts` 里是无声的。
   */
  async listAccountsDetailed(
    integrationId: string
  ): Promise<{ accounts: StoredIntegrationAccount[]; unreadable: string[] }> {
    await this.migrateLegacyOnce(integrationId);
    const accounts: StoredIntegrationAccount[] = [];
    const unreadable: string[] = [];
    for (const account of await this.accounts.listAccounts(integrationId)) {
      if (keptByPlatform(account)) {
        // #921 平台保管的那一份:本机这一行只是平台答复的镜像,背后没有密钥,❌ 去解密、❌ 当成读不出来。
        accounts.push({ ...toIntegrationAccount(account, {}), connectedAt: account.createdAt, isDefault: account.isDefault });
        continue;
      }
      const raw = await this.accounts.resolveSecret(integrationId, account.accountId);
      const credentials = raw ? parseJson(raw) : null;
      if (!credentials || typeof credentials !== 'object' || Array.isArray(credentials)) {
        this.logger.warn('Integration account has no readable credentials', { integrationId, accountId: account.accountId });
        unreadable.push(account.accountId);
        continue;
      }
      accounts.push({
        ...toIntegrationAccount(account, credentials as IntegrationCredentials),
        connectedAt: account.createdAt,
        isDefault: account.isDefault,
      });
    }
    return { accounts, unreadable };
  }

  /** 把这一家的默认账号指向 `accountId`(不存在 = 什么也不动,返回 false)。 */
  async setDefault(integrationId: string, accountId: string): Promise<boolean> {
    return (await this.accounts.setDefaultAccount(integrationId, accountId)) !== null;
  }

  async get(integrationId: string, accountId?: string): Promise<IntegrationCredentials | null> {
    const account = await this.getAccount(integrationId, accountId);
    return account?.credentials ?? null;
  }

  async upsertAccount(integrationId: string, account: IntegrationAccountRecord): Promise<void> {
    await this.accounts.upsertAccount({
      providerId: integrationId,
      accountId: account.accountId,
      secret: JSON.stringify(account.credentials),
      meta: account.displayName ? { displayName: account.displayName } : {},
    });
  }

  /** Remove one account, or every account when no accountId is given. */
  async delete(integrationId: string, accountId?: string): Promise<void> {
    if (accountId) {
      await this.accounts.removeAccount(integrationId, accountId);
      return;
    }
    await this.accounts.removeAllAccounts(integrationId);
  }

  async isConfigured(integrationId: string): Promise<boolean> {
    await this.migrateLegacyOnce(integrationId);
    return this.accounts.isConfigured(integrationId);
  }

  private async migrateLegacyOnce(integrationId: string): Promise<void> {
    if (this.legacyChecked.has(integrationId)) return;

    if (await this.accounts.isConfigured(integrationId)) {
      this.legacyChecked.add(integrationId);
      return;
    }

    try {
      const credentials = await this.readLegacyCredentials(integrationId);
      if (credentials) {
        await this.upsertAccount(integrationId, {
          accountId: DEFAULT_INTEGRATION_ACCOUNT_ID,
          credentials,
        });
        await this.clearLegacyCredentials(integrationId);
      }
      // Hit or genuine miss: no need to re-read legacy keys again.
      this.legacyChecked.add(integrationId);
    } catch (error) {
      // Do not cache: a transient failure must not mask credentials that a
      // later attempt could migrate successfully.
      this.logger.warn('Failed to migrate legacy integration credentials', {
        integrationId,
        error,
      });
    }
  }

  private async readLegacyCredentials(
    integrationId: string
  ): Promise<IntegrationCredentials | null> {
    switch (integrationId) {
      case 'linear': {
        const apiKey = readString(await this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.linear));
        return apiKey ? { apiKey } : null;
      }
      case 'jira': {
        const [rawToken, creds] = await Promise.all([
          this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.jira),
          this.legacy.kv.jira.get('creds'),
        ]);
        const apiToken = readString(rawToken);
        const siteUrl = readString(creds?.siteUrl);
        const email = readString(creds?.email);
        return apiToken && siteUrl && email ? { siteUrl, email, apiToken } : null;
      }
      case 'gitlab': {
        const [rawToken, connection] = await Promise.all([
          this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.gitlab),
          this.legacy.kv.gitlab.get('connection'),
        ]);
        const apiToken = readString(rawToken);
        const instanceUrl = readString(connection?.instanceUrl);
        return apiToken && instanceUrl ? { instanceUrl, apiToken } : null;
      }
      case 'forgejo': {
        const [rawToken, connection] = await Promise.all([
          this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.forgejo),
          this.legacy.kv.forgejo.get('connection'),
        ]);
        const apiToken = readString(rawToken);
        const instanceUrl = readString(connection?.instanceUrl);
        return apiToken && instanceUrl ? { instanceUrl, apiToken } : null;
      }
      case 'plane': {
        const [rawKey, connection] = await Promise.all([
          this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.plane),
          this.legacy.kv.plane.get('connection'),
        ]);
        const apiKey = readString(rawKey);
        const apiBaseUrl = readString(connection?.apiBaseUrl);
        const workspaceSlug = readString(connection?.workspaceSlug);
        return apiKey && apiBaseUrl && workspaceSlug ? { apiBaseUrl, workspaceSlug, apiKey } : null;
      }
      case 'plain': {
        const apiKey = readString(await this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.plain));
        return apiKey ? { apiKey } : null;
      }
      case 'featurebase': {
        const apiKey = readString(
          await this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.featurebase)
        );
        return apiKey ? { apiKey } : null;
      }
      case 'asana': {
        const accessToken = readString(
          await this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.asana)
        );
        return accessToken ? { accessToken } : null;
      }
      case 'monday': {
        const raw = await this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.monday);
        const parsed = raw ? parseJson(raw) : null;
        if (!parsed || typeof parsed !== 'object') return null;
        const candidate = parsed as Record<string, unknown>;
        const apiToken = readString(candidate.token) ?? readString(candidate.apiToken);
        if (!apiToken) return null;
        return { apiToken };
      }
      case 'trello': {
        const raw = await this.legacy.secrets.getSecret(LEGACY_SECRET_KEYS.trello);
        const parsed = raw ? parseJson(raw) : null;
        if (!parsed || typeof parsed !== 'object') return null;
        const candidate = parsed as Record<string, unknown>;
        const apiKey = readString(candidate.apiKey);
        const apiToken = readString(candidate.token) ?? readString(candidate.apiToken);
        if (!apiKey || !apiToken) return null;
        return {
          apiKey,
          apiToken,
        };
      }
      default:
        return null;
    }
  }

  private async clearLegacyCredentials(integrationId: string): Promise<void> {
    switch (integrationId) {
      case 'jira':
        await Promise.allSettled([
          this.legacy.secrets.deleteSecret(LEGACY_SECRET_KEYS.jira),
          this.legacy.kv.jira.del('creds'),
        ]);
        return;
      case 'gitlab':
        await Promise.allSettled([
          this.legacy.secrets.deleteSecret(LEGACY_SECRET_KEYS.gitlab),
          this.legacy.kv.gitlab.del('connection'),
        ]);
        return;
      case 'forgejo':
        await Promise.allSettled([
          this.legacy.secrets.deleteSecret(LEGACY_SECRET_KEYS.forgejo),
          this.legacy.kv.forgejo.del('connection'),
        ]);
        return;
      case 'plane':
        await Promise.allSettled([
          this.legacy.secrets.deleteSecret(LEGACY_SECRET_KEYS.plane),
          this.legacy.kv.plane.del('connection'),
        ]);
        return;
      default: {
        const key = LEGACY_SECRET_KEYS[integrationId as keyof typeof LEGACY_SECRET_KEYS];
        if (key) await this.legacy.secrets.deleteSecret(key).catch(() => undefined);
      }
    }
  }
}

/** #921 rows with nothing behind their credentialRef by design: the platform keeps it, or the key was rejected. */
function keptByPlatform(account: ProviderAccount): boolean {
  return account.meta?.credentialSource === PLATFORM_CREDENTIAL_SOURCE || account.meta?.credentialSource === REJECTED_KEY_SOURCE;
}

function toIntegrationAccount(
  account: ProviderAccount,
  credentials: IntegrationCredentials
): IntegrationAccountRecord {
  return {
    accountId: account.accountId,
    ...(account.meta?.displayName ? { displayName: account.meta.displayName } : {}),
    credentials,
  };
}
