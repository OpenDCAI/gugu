import { CloudComputerError } from '@gugu/core/cloud/cloudComputer';
import {
  PlatformCredentialRejectedError,
  type PlatformIntegrationsClient,
} from '@gugu/core/cloud/platformIntegrations';
import {
  integrationPluginRegistry,
  type IntegrationCredentials,
  type IntegrationError,
} from '@gugu/session-plugins/integrations';
import type {
  ProviderAccount,
  ProviderAccountMetaInput,
  ProviderAccountRegistry,
} from '@main/core/provider-accounts/provider-account-registry';
import { PLATFORM_CREDENTIAL_SOURCE } from '@shared/core/provider-accounts/provider-account-meta';
import type { IntegrationEndpoint } from '../../../../integration-mcp-bridge';
import { DEFAULT_INTEGRATION_ACCOUNT_ID } from './integration-credential-store';

/**
 * #921 人自己填的凭据由平台保管(高德先上)。这一台设备上:
 *  · 连接 = 把表单交给平台(`PUT …/credential`),本机只记一行「平台替他存着」,❌ 存任何密钥;
 *  · 连没连 = 平台说了算(`GET /integrations`)。平台的答复照抄进本机账号表(资源库、助理面板与索引读的就是它),
 *    问不到时用上一次的答复 —— 另一台设备(含云电脑)连的,这台照样算连着;
 *  · 会话里的工具 = 平台的 MCP 转发口,每次调用现取本人的会话令牌;
 *  · 断开 = `DELETE …/credential`,所有设备一起断;
 *  · #649 留在本机加密库里的 key:上传一次,传成功了才删本机那份;传不上就留着,过一阵再试。
 * 凭据 ❌ 进日志、❌ 进任何报错。
 */

export type PlatformCustodyProvider = {
  id: string;
  name: string;
  fields: readonly { id: string; secret: boolean; required: boolean }[];
};

/** 注册表里表单连接方式标了 `custody: 'platform'` 的那几家。 */
export function platformCustodyProviders(): PlatformCustodyProvider[] {
  return integrationPluginRegistry.getAll().flatMap((plugin) => {
    const form = plugin.capabilities.auth.methods.find(
      (method) => method.kind === 'form' && method.custody === 'platform'
    );
    if (form?.kind !== 'form') return [];
    return [{
      id: plugin.metadata.id,
      name: plugin.metadata.name,
      fields: form.fields.map(({ id, secret, required }) => ({ id, secret, required })),
    }];
  });
}

type Accounts = Pick<
  ProviderAccountRegistry,
  'listAccounts' | 'upsertAccount' | 'removeAccount' | 'removeAllAccounts' | 'clearSecret' | 'resolveSecret'
>;

type Log = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
};

export type PlatformCredentialDeps = {
  /** null = this installation has no platform to keep credentials. */
  client: () => PlatformIntegrationsClient | null;
  accounts: Accounts;
  providers: () => readonly PlatformCustodyProvider[];
  log: Log;
  now?: () => number;
};

export type PlatformConnectResult =
  | { success: true }
  | { success: false; error: string; errorType?: IntegrationError['type'] };

export type PlatformConnectionCheck =
  | { connected: true }
  | { connected: false; error?: string; errorType?: IntegrationError['type'] };

/** provider → accountId → 平台说它能用(false = 存着,但对方不认了,要重连)。 */
type Snapshot = Map<string, Map<string, boolean>>;

/** #649 的 key 传不上之后,隔这么久再试(❌ 每开一条会话就打一次平台)。 */
const MIGRATION_RETRY_MS = 5 * 60_000;
/** 资源库、面板这类「看一眼」的读:这么久之内问过就不再问。开会话前总是现问。 */
const DEFAULT_MAX_AGE_MS = 30_000;

function keptByPlatform(account: ProviderAccount): boolean {
  return account.meta?.credentialSource === PLATFORM_CREDENTIAL_SOURCE;
}

/** 这一行的 meta 去掉版本号、标成平台保管(显示名等原样留着)。 */
function platformMeta(account: ProviderAccount | undefined): ProviderAccountMetaInput {
  const { version: _version, ...rest } = account?.meta ?? { version: '1' as const };
  return { ...rest, credentialSource: PLATFORM_CREDENTIAL_SOURCE };
}

function failureOf(error: unknown): { code: string; status: number; message: string } {
  if (error instanceof CloudComputerError) return { code: error.code, status: error.status, message: error.message };
  return { code: 'error', status: 0, message: error instanceof Error ? error.message : String(error) };
}

function unavailable(name: string): CloudComputerError {
  return new CloudComputerError(0, 'unavailable', `${name} needs the Gugu platform, which this installation does not have.`);
}

/** 平台的出错码 → 界面已有的那几类说法;报错里出现的凭据一律打码(哪怕平台本不该带它)。 */
function connectFailure(error: unknown, name: string, secrets: readonly string[]): PlatformConnectResult {
  const failure = failureOf(error);
  const said = secrets.reduce((text, secret) => text.split(secret).join('***'), failure.message);
  switch (failure.code) {
    case 'auth_failed':
      return { success: false, error: `${name} rejected the credential: ${said}`, errorType: 'auth_failed' };
    case 'invalid_fields':
      return { success: false, error: said, errorType: 'invalid_input' };
    case 'upstream_unavailable':
      return { success: false, error: `${name} could not be reached from the Gugu platform: ${said}`, errorType: 'host_unreachable' };
    case 'not_open':
      return { success: false, error: `${name} is not open in this environment yet.`, errorType: 'generic' };
    case 'unknown_provider':
      return { success: false, error: `The Gugu platform does not offer ${name} yet.`, errorType: 'generic' };
    default:
      return { success: false, error: `Could not save the ${name} credential on the Gugu platform: ${said}`, errorType: 'generic' };
  }
}

export class PlatformCredentialService {
  private snapshot: Snapshot | null = null;
  private fetchedAt = 0;
  private lastFailure: { code: string; message: string } | null = null;
  private pending: Promise<boolean> | null = null;
  /** 改本机镜像的事(问平台、连接、断开)一件接一件:❌ 让一次晚到的「没连」答复抹掉刚连上的那一行。 */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly migrationRetryAt = new Map<string, number>();

  constructor(private readonly deps: PlatformCredentialDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private provider(integrationId: string): PlatformCustodyProvider | null {
    return this.deps.providers().find((provider) => provider.id === integrationId) ?? null;
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  isPlatformProvider(integrationId: string): boolean {
    return this.provider(integrationId) !== null;
  }

  /** 登录变了 / 转发口说变了:下一次读必须现问。 */
  invalidate(): void {
    this.fetchedAt = 0;
  }

  /**
   * 问平台哪些连着,顺手把 #649 的本机 key 传上去,再把答复照抄进本机账号表。同一时刻只问一次(后来的跟着等)。
   * 问到了 = true;问不到(没登录、没网、这个环境没开放)= false,本机账号表不动、之前的答复照旧有效。❌ 抛错。
   * `maxAgeMs: 0` = 一定现问。
   */
  refresh(options: { maxAgeMs?: number } = {}): Promise<boolean> {
    if (this.pending) return this.pending;
    const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (this.snapshot && maxAge > 0 && this.fetchedAt > 0 && this.now() - this.fetchedAt < maxAge) {
      return Promise.resolve(true);
    }
    const run = this.serialize(() => this.refreshNow());
    this.pending = run;
    void run.finally(() => {
      if (this.pending === run) this.pending = null;
    });
    return run;
  }

  private async refreshNow(): Promise<boolean> {
    const providers = this.deps.providers();
    if (providers.length === 0) return true;
    let client: PlatformIntegrationsClient | null;
    let snapshot: Snapshot;
    try {
      client = this.deps.client();
      if (!client) throw unavailable(providers.map((provider) => provider.name).join(', '));
      const listed = await client.list();
      snapshot = new Map(providers.map((provider) => [
        provider.id,
        new Map((listed.find((row) => row.provider === provider.id)?.accounts ?? []).map((account) => [account.accountId, account.connected])),
      ]));
    } catch (error) {
      const failure = failureOf(error);
      if (this.lastFailure?.code !== failure.code) {
        this.deps.log.warn('Could not ask the Gugu platform which credentials it keeps; using its last answer', {
          code: failure.code,
          status: failure.status,
        });
      }
      this.lastFailure = { code: failure.code, message: failure.message };
      return false;
    }
    for (const provider of providers) {
      try {
        await this.moveLocalKeys(client, provider, snapshot.get(provider.id)!);
        await this.mirror(provider.id, snapshot.get(provider.id)!);
      } catch (error) {
        this.deps.log.warn('Could not record the platform-kept credentials on this device', {
          provider: provider.id,
          code: failureOf(error).code,
        });
      }
    }
    this.snapshot = snapshot;
    this.fetchedAt = this.now();
    this.lastFailure = null;
    return true;
  }

  /** #649 留在本机加密库里的那份:上传;成功了才删本机的。平台那边已有一份能用的,本机这份就是多余的了。 */
  private async moveLocalKeys(
    client: PlatformIntegrationsClient,
    provider: PlatformCustodyProvider,
    known: Map<string, boolean>
  ): Promise<void> {
    for (const row of await this.deps.accounts.listAccounts(provider.id)) {
      if (keptByPlatform(row)) continue;
      const fields = await this.localFields(provider, row);
      if (!fields) continue;
      if ([...known.values()].some(Boolean)) {
        await this.keepOnPlatformOnly(provider.id, row);
        continue;
      }
      if ((this.migrationRetryAt.get(provider.id) ?? 0) > this.now()) continue;
      try {
        await client.saveCredential(provider.id, fields);
      } catch (error) {
        this.migrationRetryAt.set(provider.id, this.now() + MIGRATION_RETRY_MS);
        const failure = failureOf(error);
        this.deps.log.warn('A credential saved on this device could not be moved to the Gugu platform yet; it stays here and is retried later', {
          provider: provider.id,
          code: failure.code,
          status: failure.status,
        });
        continue;
      }
      this.migrationRetryAt.delete(provider.id);
      known.set(DEFAULT_INTEGRATION_ACCOUNT_ID, true);
      await this.keepOnPlatformOnly(provider.id, row);
      this.deps.log.info('A credential saved on this device moved to the Gugu platform', { provider: provider.id });
    }
  }

  private async localFields(
    provider: PlatformCustodyProvider,
    row: ProviderAccount
  ): Promise<Record<string, string> | null> {
    let raw: string | null;
    try {
      raw = await this.deps.accounts.resolveSecret(provider.id, row.accountId);
    } catch (error) {
      this.deps.log.warn('A credential saved on this device could not be read', { provider: provider.id, code: failureOf(error).code });
      return null;
    }
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const saved = parsed as Record<string, unknown>;
    const fields: Record<string, string> = {};
    for (const field of provider.fields) {
      const value = saved[field.id];
      if (typeof value === 'string' && value.trim()) fields[field.id] = value.trim();
    }
    return provider.fields.every((field) => !field.required || fields[field.id]) && Object.keys(fields).length > 0 ? fields : null;
  }

  /** 先把这一行标成平台保管,再删它背后的密钥:哪一步失败,都不会留下「平台没有、本机也没了」。 */
  private async keepOnPlatformOnly(providerId: string, row: ProviderAccount): Promise<void> {
    await this.deps.accounts.upsertAccount({ providerId, accountId: row.accountId, meta: platformMeta(row) });
    await this.deps.accounts.clearSecret(providerId, row.accountId);
  }

  /** 平台的答复照抄进本机账号表:只动标着平台保管的行,且只在真有变化时动(每动一次面板就重发一次)。 */
  private async mirror(providerId: string, accounts: Map<string, boolean>): Promise<void> {
    const rows = await this.deps.accounts.listAccounts(providerId);
    for (const accountId of accounts.keys()) {
      if (rows.some((row) => row.accountId === accountId)) continue;
      await this.deps.accounts.upsertAccount({ providerId, accountId, meta: { credentialSource: PLATFORM_CREDENTIAL_SOURCE } });
    }
    for (const row of rows) {
      if (keptByPlatform(row) && !accounts.has(row.accountId)) await this.deps.accounts.removeAccount(providerId, row.accountId);
    }
  }

  /**
   * 开会话时这一家给不给工具:平台最近一次的答复;这个进程里还没问到过,就看本机账号表里上次照抄下来的那一行。
   * 要现问,先 `refresh({ maxAgeMs: 0 })`。
   */
  async isConnected(integrationId: string): Promise<boolean> {
    if (this.snapshot) return [...(this.snapshot.get(integrationId)?.values() ?? [])].some(Boolean);
    return (await this.deps.accounts.listAccounts(integrationId)).some(keptByPlatform);
  }

  /** 资源库 / 面板上的「连接状态」:现问平台。存着但对方不认了 = 要重连(❌ 说成登录问题)。 */
  async check(integrationId: string): Promise<PlatformConnectionCheck> {
    const answered = await this.refresh({ maxAgeMs: 0 });
    if (!answered) return { connected: false, error: this.lastFailure?.message ?? 'Could not reach the Gugu platform.' };
    const accounts = this.snapshot?.get(integrationId);
    if (accounts && [...accounts.values()].some(Boolean)) return { connected: true };
    if (accounts && accounts.size > 0) {
      return { connected: false, errorType: 'authorization_expired', error: new PlatformCredentialRejectedError(integrationId).message };
    }
    return { connected: false };
  }

  async checkAccounts(
    integrationId: string
  ): Promise<{ accountId: string; connected: boolean; error?: string; errorType?: IntegrationError['type'] }[]> {
    const answered = await this.refresh({ maxAgeMs: 0 });
    const known = this.snapshot?.get(integrationId);
    return (await this.deps.accounts.listAccounts(integrationId)).map((row) => {
      if (!answered) return { accountId: row.accountId, connected: false, error: this.lastFailure?.message ?? 'Could not reach the Gugu platform.' };
      const connected = known?.get(row.accountId);
      if (connected) return { accountId: row.accountId, connected: true };
      if (connected === false) {
        return { accountId: row.accountId, connected: false, errorType: 'authorization_expired', error: new PlatformCredentialRejectedError(integrationId).message };
      }
      return { accountId: row.accountId, connected: false };
    });
  }

  /** 表单交给平台;平台验过、存下了,本机只记一行(没有密钥)。`editing`:「编辑凭据」—— 本机没有存着的可沿用,留空就是缺。 */
  connect(integrationId: string, input: IntegrationCredentials, options: { editing?: boolean } = {}): Promise<PlatformConnectResult> {
    return this.serialize(async () => {
      const provider = this.provider(integrationId);
      if (!provider) return { success: false, error: `Unknown integration: ${integrationId}` };
      const fields: Record<string, string> = {};
      for (const field of provider.fields) {
        const value = input[field.id];
        if (typeof value === 'string' && value.trim()) fields[field.id] = value.trim();
      }
      const missing = provider.fields.filter((field) => field.required && !fields[field.id]).map((field) => field.id);
      if (missing.length > 0) {
        return {
          success: false,
          error: `${missing.join(', ')} ${options.editing ? 'must be entered again: the Gugu platform keeps it and no device holds a copy.' : 'is required.'}`,
          errorType: 'invalid_input',
        };
      }
      const secrets = provider.fields.flatMap((field) => (field.secret && fields[field.id] ? [fields[field.id]!] : []));
      try {
        const client = this.deps.client();
        if (!client) throw unavailable(provider.name);
        await client.saveCredential(integrationId, fields);
      } catch (error) {
        const failure = failureOf(error);
        this.deps.log.warn('The Gugu platform did not keep the credential', { provider: integrationId, code: failure.code, status: failure.status });
        return connectFailure(error, provider.name, secrets);
      }
      const row = (await this.deps.accounts.listAccounts(integrationId)).find(
        (account) => account.accountId === DEFAULT_INTEGRATION_ACCOUNT_ID
      );
      if (row && !keptByPlatform(row)) {
        // 这一台上 #649 那份还没传上去:新的已在平台,旧的作废。
        await this.keepOnPlatformOnly(integrationId, row);
      } else if (!row) {
        await this.deps.accounts.upsertAccount({
          providerId: integrationId,
          accountId: DEFAULT_INTEGRATION_ACCOUNT_ID,
          meta: { credentialSource: PLATFORM_CREDENTIAL_SOURCE },
        });
      } else {
        await this.deps.accounts.upsertAccount({ providerId: integrationId, accountId: row.accountId, meta: platformMeta(row) });
      }
      this.snapshot?.set(integrationId, new Map([[DEFAULT_INTEGRATION_ACCOUNT_ID, true]]));
      this.migrationRetryAt.delete(integrationId);
      return { success: true };
    });
  }

  /** 平台上删掉(所有设备一起断),再删本机这一行。平台没删成 = 本机也不动,卡片还在「已连接」、还能再点。 */
  disconnect(integrationId: string): Promise<{ success: boolean; error?: string }> {
    return this.serialize(async () => {
      const provider = this.provider(integrationId);
      if (!provider) return { success: false, error: `Unknown integration: ${integrationId}` };
      try {
        // 这个安装根本没有平台:平台上也就没有,只剩本机那一行要删。
        await this.deps.client()?.deleteCredential(integrationId);
      } catch (error) {
        const failure = failureOf(error);
        if (failure.code !== 'not_connected') {
          this.deps.log.warn('The Gugu platform did not remove the credential', { provider: integrationId, code: failure.code, status: failure.status });
          return { success: false, error: `Could not disconnect ${provider.name} on the Gugu platform: ${failure.message}` };
        }
      }
      await this.deps.accounts.removeAllAccounts(integrationId);
      this.snapshot?.set(integrationId, new Map());
      this.migrationRetryAt.delete(integrationId);
      return { success: true };
    });
  }

  /**
   * 会话里这一家那台 MCP 每次调用现取的转发口:平台的地址 + 本人此刻的会话令牌,凭据由平台挂上。
   * 转发口说没存 / 存着的被拒了 → 这一次调用明确失败,本机也跟着去问一次平台。
   */
  async mcpEndpoint(integrationId: string, signal?: AbortSignal): Promise<IntegrationEndpoint> {
    signal?.throwIfAborted();
    const client = this.deps.client();
    if (!client) throw unavailable(integrationId);
    const endpoint = await client.mcpEndpoint(integrationId, {
      onNotConnected: () => this.heard(integrationId, false),
      onCredentialRejected: () => this.heard(integrationId, true),
    });
    signal?.throwIfAborted();
    return endpoint;
  }

  private heard(integrationId: string, stillStored: boolean): void {
    const accounts = this.snapshot?.get(integrationId);
    this.snapshot?.set(integrationId, new Map(stillStored ? [...(accounts?.keys() ?? [])].map((id) => [id, false] as const) : []));
    this.invalidate();
    void this.refresh({ maxAgeMs: 0 });
  }
}
