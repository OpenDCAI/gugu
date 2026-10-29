import { CloudComputerError } from '@gugu/core/cloud/cloudComputer';
import {
  isPlatformServiceMissing,
  PlatformCredentialRejectedError,
  type PlatformIntegrationProvider,
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
import { PLATFORM_CREDENTIAL_SOURCE, REJECTED_KEY_SOURCE } from '@shared/core/provider-accounts/provider-account-meta';
import type { IntegrationEndpoint } from '../../../../integration-mcp-bridge';
import { DEFAULT_INTEGRATION_ACCOUNT_ID } from './integration-credential-store';

/**
 * #921 人自己填的凭据由平台保管(高德先上)。这一台设备上:
 *  · 连接 = 把表单交给平台(`PUT …/credential`),本机只记一行「平台替他存着」,❌ 存任何密钥;
 *  · 连没连 = 平台说了算(`GET /integrations`)。平台的答复照抄进本机账号表(资源库、助理面板与索引读的就是它),
 *    问不到时用上一次的答复 —— 另一台设备(含云电脑)连的,这台照样算连着;
 *  · 会话里的工具 = 平台的 MCP 转发口,每次调用现取本人的会话令牌;
 *  · 断开 = `DELETE …/credential`,所有设备一起断;
 *  · #649 留在本机加密库里的 key:作为「搬迁」上传一次,传成功了才删本机那份;传不上就留着,过一阵再试。
 *    ❌ 推翻这个人的断开:平台说断开过 / 已存着一份,本机这份就作废删掉,不传。#649 没记过 key 是什么时候存的
 *    (账号行的 updatedAt 每核一次就刷新,createdAt 会被搬家改写),所以存的时刻一律报「不知道」。
 * 唯一的退路:这个安装压根没有这项平台服务(没配平台地址,或网关回「没有这个函数」的 404)—— 只有这时凭据才留在
 * 这台电脑上(#649 的老路,`custody() === 'local'`)。平台在、但说 503 not_open = 「还没对你开放」,❌ 改存本机。
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
  /** 问「哪些连着」最多等多久(默认 5 s)。 */
  listTimeoutMs?: number;
};

export type PlatformConnectResult =
  | { success: true }
  | { success: false; error: string; errorType?: IntegrationError['type'] }
  /** 这个安装没有这项平台服务:由调用方照本机保管的老路连(核对、存进这台电脑的加密凭据库)。 */
  | { keepHere: true };

export type PlatformConnectionCheck =
  | { connected: true }
  | { connected: false; error?: string; errorType?: IntegrationError['type'] };

/** provider → accountId → 平台说它能用(false = 存着,但对方不认了,要重连)。 */
type Snapshot = Map<string, Map<string, boolean>>;

/**
 * #649 的 key 传不上之后,隔多久再试:从 5 分钟起每次翻倍,最多 1 小时(❌ 每开一条会话就打一次平台)。
 * 封顶 1 小时:原因一消失(平台恢复、高德额度重置、对这个人开放),一小时内就搬上去;一直不成的设备每小时最多打一次 PUT。
 */
const MIGRATION_RETRY_FIRST_MS = 5 * 60_000;
const MIGRATION_RETRY_MAX_MS = 60 * 60_000;
/** 资源库、面板这类「看一眼」的读:这么久之内问过就不再问。开会话前总是现问。 */
const DEFAULT_MAX_AGE_MS = 30_000;
/** 没问到之后,「看一眼」的读这么久之内不再等平台(❌ 每次开资源库都卡一个超时)。 */
const FAILURE_HOLD_MS = 30_000;
/** 问「哪些连着」最多等这么久:开会话、开资源库都在等它。 */
const LIST_TIMEOUT_MS = 5_000;

function keptByPlatform(account: ProviderAccount): boolean {
  return account.meta?.credentialSource === PLATFORM_CREDENTIAL_SOURCE;
}

/** #649 的 key 在搬上平台时被对方拒了:key 已删,这一行留着,好让连接页请他重新填。 */
function keyRejected(account: ProviderAccount): boolean {
  return account.meta?.credentialSource === REJECTED_KEY_SOURCE;
}

function keyRejectedCheck(name: string): { connected: false; error: string; errorType: IntegrationError['type'] } {
  return { connected: false, error: `${name} rejected this key; enter it again.`, errorType: 'key_rejected' };
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

/** 对方回了话、但这会儿用不了(额度、QPS、临时错误):稍后再试。 */
function unavailable(name: string): string {
  return `${name} isn't available right now; try again later.`;
}

/** 这台设备连不上平台(没网,或等不到回话)。 */
const NO_NETWORK = "Can't reach Gugu; check your network.";

function notOpen(name: string): string {
  return `Gugu hasn't opened the ${name} connection to you yet.`;
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
      return { success: false, error: unavailable(name), errorType: 'provider_unavailable' };
    case 'not_open':
      return { success: false, error: notOpen(name), errorType: 'not_open' };
    case 'unknown_provider':
      return { success: false, error: `The Gugu platform does not offer ${name} yet.`, errorType: 'generic' };
    case 'request_timeout':
      return { success: false, error: "Your request didn't reach Gugu in time; your network may be unstable.", errorType: 'timed_out' };
    case 'network':
      return { success: false, error: NO_NETWORK, errorType: 'network' };
    case 'rate_limited':
    case 'too_many_streams':
      return { success: false, error: `Too many requests to ${name} right now; try again shortly.`, errorType: 'rate_limited' };
    default:
      return { success: false, error: `Could not save the ${name} credential on the Gugu platform: ${said}`, errorType: 'generic' };
  }
}

export class PlatformCredentialService {
  /** absent = 这个安装压根没有这项服务(唯一把凭据留在本机的情况);unknown = 还没问到过。 */
  private availability: 'unknown' | 'present' | 'absent' = 'unknown';
  private snapshot: Snapshot | null = null;
  private fetchedAt = 0;
  /** 上一次没问到的时刻:之后一阵子「看一眼」的读不再等平台(开会话的那一次照样现问)。 */
  private failedAt = 0;
  private lastFailure: { code: string; message: string } | null = null;
  /** 登录一变就换一代:上一代问到的答复 ❌ 算给这一代。 */
  private generation = 0;
  private pending: { generation: number; run: Promise<boolean> } | null = null;
  /** 改本机镜像的事(问平台、连接、断开)一件接一件:❌ 让一次晚到的「没连」答复抹掉刚连上的那一行。 */
  private queue: Promise<unknown> = Promise.resolve();
  private readonly migrationRetryAt = new Map<string, number>();
  /** 连着失败了几次(决定下一次隔多久);成功、作废、明确连上 / 断开都清零。 */
  private readonly migrationFailures = new Map<string, number>();
  /** 上一次没搬成的原因(平台的码):连接页据此说「这会儿用不了」,而不是什么都不说。 */
  private readonly migrationFailureCode = new Map<string, string>();

  constructor(private readonly deps: PlatformCredentialDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private get listTimeoutMs(): number {
    return this.deps.listTimeoutMs ?? LIST_TIMEOUT_MS;
  }

  private provider(integrationId: string): PlatformCustodyProvider | null {
    return this.deps.providers().find((provider) => provider.id === integrationId) ?? null;
  }

  /** 平台的客户端;这个安装没配平台(或连库地址都没有)= null。 */
  private client(): PlatformIntegrationsClient | null {
    try {
      return this.deps.client();
    } catch {
      return null;
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  isPlatformProvider(integrationId: string): boolean {
    return this.provider(integrationId) !== null;
  }

  /**
   * 这一家的凭据此刻在哪保管:平台;只有这个安装确知没有这项服务时(没配平台,或网关说没有这个函数)才是这台电脑
   * (`local`)。还没问到过 = 平台 —— ❌ 因为一时问不到就改存本机。
   */
  custody(integrationId: string): 'platform' | 'local' | null {
    if (!this.isPlatformProvider(integrationId)) return null;
    return this.availability === 'absent' || !this.client() ? 'local' : 'platform';
  }

  /** 还不知道这个安装有没有这项服务就先问一次(资源库要按它说「平台保管」还是「这台电脑上保管」)。 */
  async knowCustody(): Promise<void> {
    if (this.availability === 'unknown') await this.refresh();
  }

  /** 这个安装没有这项服务:之前照抄下来的「平台保管」那几行也就不作数了,删掉(它们背后本来就没有密钥)。 */
  private async serviceMissing(providers: readonly PlatformCustodyProvider[]): Promise<void> {
    if (this.availability !== 'absent') {
      this.deps.log.info('This installation has no platform service for typed-in credentials; they are kept on this computer');
    }
    this.availability = 'absent';
    this.snapshot = null;
    this.fetchedAt = this.now();
    this.failedAt = 0;
    this.lastFailure = null;
    for (const provider of providers) {
      for (const row of await this.deps.accounts.listAccounts(provider.id)) {
        if (keptByPlatform(row) || keyRejected(row)) await this.deps.accounts.removeAccount(provider.id, row.accountId);
      }
    }
  }

  /** 登录变了 / 转发口说变了:下一次读必须现问,正在问的那一次的答复也不作数了。 */
  invalidate(): void {
    this.fetchedAt = 0;
    this.failedAt = 0;
    this.generation += 1;
  }

  /**
   * 问平台哪些连着,顺手把 #649 的本机 key 传上去,再把答复照抄进本机账号表。同一时刻只问一次(同一代的跟着等)。
   * 问到了 = true;问不到(没登录、没网、这个环境没开放)= false,本机账号表不动、之前的答复照旧有效。❌ 抛错。
   * `maxAgeMs: 0` = 一定现问;别的读在刚问过、或刚没问到的一阵子里不再等平台。
   */
  refresh(options: { maxAgeMs?: number } = {}): Promise<boolean> {
    if (this.pending && this.pending.generation === this.generation) return this.pending.run;
    const maxAge = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    if (maxAge > 0) {
      const now = this.now();
      if ((this.snapshot || this.availability === 'absent') && this.fetchedAt > 0 && now - this.fetchedAt < maxAge) return Promise.resolve(true);
      if (this.failedAt > 0 && now - this.failedAt < FAILURE_HOLD_MS) return Promise.resolve(false);
    }
    const generation = this.generation;
    const run = this.serialize(() => this.refreshNow(generation).catch((error: unknown) => {
      this.deps.log.warn('Could not refresh the platform-kept credentials', { code: failureOf(error).code });
      return false;
    }));
    const entry = { generation, run };
    this.pending = entry;
    void run.finally(() => {
      if (this.pending === entry) this.pending = null;
    });
    return run;
  }

  private async refreshNow(generation: number): Promise<boolean> {
    const providers = this.deps.providers();
    if (providers.length === 0) return true;
    const client = this.client();
    if (!client) {
      await this.serviceMissing(providers);
      return true;
    }
    let snapshot: Snapshot;
    let listed: PlatformIntegrationProvider[];
    try {
      listed = await client.list(AbortSignal.timeout(this.listTimeoutMs));
      snapshot = new Map(providers.map((provider) => [
        provider.id,
        new Map((listed.find((row) => row.provider === provider.id)?.accounts ?? []).map((account) => [account.accountId, account.connected])),
      ]));
    } catch (error) {
      if (generation !== this.generation) return false;
      if (isPlatformServiceMissing(error)) {
        await this.serviceMissing(providers);
        return true;
      }
      const failure = failureOf(error);
      if (failure.code === 'not_open') this.availability = 'present';
      if (this.lastFailure?.code !== failure.code) {
        this.deps.log.warn('Could not ask the Gugu platform which credentials it keeps; using its last answer', {
          code: failure.code,
          status: failure.status,
        });
      }
      this.lastFailure = { code: failure.code, message: failure.message };
      this.failedAt = this.now();
      return false;
    }
    // 问的时候登录已经换了:这是上一个人的答复,❌ 照抄、❌ 拿它的 key 去传。
    if (generation !== this.generation) return false;
    for (const provider of providers) {
      try {
        await this.moveLocalKeys(client, provider, listed.find((row) => row.provider === provider.id), snapshot.get(provider.id)!);
        await this.mirror(provider.id, snapshot.get(provider.id)!);
      } catch (error) {
        this.deps.log.warn('Could not record the platform-kept credentials on this device', {
          provider: provider.id,
          code: failureOf(error).code,
        });
      }
    }
    this.availability = 'present';
    this.snapshot = snapshot;
    this.fetchedAt = this.now();
    this.failedAt = 0;
    this.lastFailure = null;
    return true;
  }

  /** 问不到平台时给界面的那一句:没对你开放 = not_open(❌ 说成连不上 / 登录问题)。 */
  private unansweredCheck(integrationId: string): { connected: false; error: string; errorType?: IntegrationError['type'] } {
    if (this.lastFailure?.code === 'not_open') {
      return { connected: false, error: notOpen(this.provider(integrationId)?.name ?? integrationId), errorType: 'not_open' };
    }
    if (this.lastFailure?.code === 'network') return { connected: false, error: NO_NETWORK, errorType: 'network' };
    return { connected: false, error: this.lastFailure?.message ?? 'Could not reach the Gugu platform.' };
  }

  /**
   * #649 留在本机加密库里的那份,作为搬迁传上平台;成功了才删本机的。这个人的明确操作压过它:
   *  · 平台已存着一份(连着的、要重连的都算)→ ❌ 覆盖,本机这份作废,照平台的显示;
   *  · 这个人断开过 → 本机这份作废,不传(#649 没记过它是什么时候存的,就当它早于那次断开);
   *  · 平台在两步之间才知道的(409 already_connected / disconnected_after)→ 一样作废,❌ 再试;
   *  · 平台说对方不认这把 key(422 auth_failed)/ 字段不对(400 invalid_fields)→ 删掉、❌ 再试,连接页请他重新填。
   *    只认平台自己的这两个码:代理、网关回的 400 / 422 说明不了 key,留着。
   * 别的(网络、5xx、401 / 403 / 404 / 408 / 429、没有平台码的 400 / 422、平台没列这一家)都留着 key、退避再试。
   */
  private async moveLocalKeys(
    client: PlatformIntegrationsClient,
    provider: PlatformCustodyProvider,
    listed: PlatformIntegrationProvider | undefined,
    known: Map<string, boolean>
  ): Promise<void> {
    for (const row of await this.deps.accounts.listAccounts(provider.id)) {
      // #649 只存过默认那一个账号;别的本机行不是它存的,原样不动。
      if (keptByPlatform(row) || row.accountId !== DEFAULT_INTEGRATION_ACCOUNT_ID) continue;
      const fields = await this.localFields(provider, row);
      if (!fields) continue;
      if (known.size > 0) {
        await this.keepOnPlatformOnly(provider.id, row);
        continue;
      }
      if (listed?.disconnectedAt[row.accountId]) {
        await this.dropDisconnected(provider.id, row);
        continue;
      }
      // 资源库、详情页的「看一眼」(切回窗口、每 30 s)都走这里:等不到下一格就不传,❌ 每看一眼都让平台再试一把 key。
      if ((this.migrationRetryAt.get(provider.id) ?? 0) > this.now()) continue;
      // 平台没列这一家:它现在收不了,❌ 传。
      if (!listed) {
        this.backOff(provider.id, { code: 'not_listed', status: 0 });
        continue;
      }
      try {
        await client.saveCredential(provider.id, fields, { migration: { savedAt: null } });
      } catch (error) {
        const failure = failureOf(error);
        if (failure.code === 'already_connected') {
          this.clearBackOff(provider.id);
          known.set(row.accountId, true);
          await this.keepOnPlatformOnly(provider.id, row);
          continue;
        }
        if (failure.code === 'disconnected_after') {
          this.clearBackOff(provider.id);
          await this.dropDisconnected(provider.id, row);
          continue;
        }
        if ((failure.status === 400 && failure.code === 'invalid_fields') || (failure.status === 422 && failure.code === 'auth_failed')) {
          this.clearBackOff(provider.id);
          await this.markKeyRejected(provider.id, row);
          this.deps.log.warn('A credential saved on this device was rejected on its way to the Gugu platform; it was dropped', {
            provider: provider.id,
            code: failure.code,
            status: failure.status,
          });
          continue;
        }
        this.backOff(provider.id, failure);
        continue;
      }
      this.clearBackOff(provider.id);
      known.set(DEFAULT_INTEGRATION_ACCOUNT_ID, true);
      await this.keepOnPlatformOnly(provider.id, row);
      this.deps.log.info('A credential saved on this device moved to the Gugu platform', { provider: provider.id });
    }
  }

  /**
   * 连接时这台没等到回话:平台列表里这一家默认账号连着、**而且是这次 PUT 发出之后存的**,才算存下了
   * (❌ 把编辑前那把旧 key 的「连着」当成新的)。「之后」用平台的钟比:重读应答的 `Date` 头(整秒,补 1 s),
   * 减去这台从发出 PUT 到开始重读过了多久(一段时长,与这台的钟快慢无关)= 这次 PUT 最晚在平台钟上的哪一刻发出;
   * 平台存它的时刻(`updatedAt`)晚于这一刻才算。没有 `Date` 头就不推断,照实说连不上。
   */
  private async keptAfterAll(client: PlatformIntegrationsClient, integrationId: string, sentAt: number): Promise<boolean> {
    const sinceSent = this.now() - sentAt;
    try {
      const { providers, platformNow } = await client.listWithClock(AbortSignal.timeout(this.listTimeoutMs));
      if (platformNow === null) return false;
      const sentBy = platformNow + 1_000 - sinceSent;
      return (providers.find((row) => row.provider === integrationId)?.accounts ?? []).some(
        (account) =>
          account.accountId === DEFAULT_INTEGRATION_ACCOUNT_ID &&
          account.connected &&
          account.updatedAt !== null &&
          Date.parse(account.updatedAt) > sentBy
      );
    } catch {
      return false;
    }
  }

  /** 这把 key 这次没搬成、还留着:下一次隔得更久一点(封顶 1 小时)。 */
  private backOff(providerId: string, failure: { code: string; status: number }): void {
    const failures = (this.migrationFailures.get(providerId) ?? 0) + 1;
    this.migrationFailures.set(providerId, failures);
    this.migrationFailureCode.set(providerId, failure.code);
    const wait = Math.min(MIGRATION_RETRY_FIRST_MS * 2 ** (failures - 1), MIGRATION_RETRY_MAX_MS);
    this.migrationRetryAt.set(providerId, this.now() + wait);
    this.deps.log.warn('A credential saved on this device could not be moved to the Gugu platform yet; it stays here and is retried later', {
      provider: providerId,
      code: failure.code,
      status: failure.status,
      retryInMinutes: wait / 60_000,
    });
  }

  private clearBackOff(providerId: string): void {
    this.migrationRetryAt.delete(providerId);
    this.migrationFailures.delete(providerId);
    this.migrationFailureCode.delete(providerId);
  }

  /** 这台上还留着 #649 的 key,上一次往上搬时平台说对方这会儿用不了:照这个说(暂时的,❌ 要重连)。 */
  private heldKeyUnavailable(integrationId: string, row: ProviderAccount): PlatformConnectionCheck | null {
    if (keptByPlatform(row) || keyRejected(row) || row.accountId !== DEFAULT_INTEGRATION_ACCOUNT_ID) return null;
    if (this.migrationFailureCode.get(integrationId) !== 'upstream_unavailable') return null;
    return { connected: false, error: unavailable(this.provider(integrationId)?.name ?? integrationId), errorType: 'provider_unavailable' };
  }

  /** 先标成「被拒了」,再删 key:哪一步失败,都不会留下一把还会被反复上传的 key 却没有标记。 */
  private async markKeyRejected(providerId: string, row: ProviderAccount): Promise<void> {
    const { version: _version, ...rest } = row.meta ?? { version: '1' as const };
    await this.deps.accounts.upsertAccount({ providerId, accountId: row.accountId, meta: { ...rest, credentialSource: REJECTED_KEY_SOURCE } });
    await this.deps.accounts.clearSecret(providerId, row.accountId);
  }

  /** 这个人断开过:本机这份 #649 的 key 连同这一行一起删掉(❌ 传上去把它连回来)。 */
  private async dropDisconnected(providerId: string, row: ProviderAccount): Promise<void> {
    await this.deps.accounts.removeAccount(providerId, row.accountId);
    this.deps.log.info('A credential saved on this device was dropped: it was disconnected in Gugu since', { provider: providerId });
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
      const row = rows.find((candidate) => candidate.accountId === accountId);
      // 被拒的那一行:平台现在存着一份(别的设备连的)就以平台为准。
      if (row && keyRejected(row)) await this.deps.accounts.upsertAccount({ providerId, accountId, meta: platformMeta(row) });
      if (row) continue;
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

  /**
   * 这一行此刻用不了、要他重连:平台说存着的被拒了,或这台设备上那把旧 key 搬上去时被拒了。按已知的答复说,❌ 现问。
   * 助理的连接索引据此不把它当成能用的。
   */
  needsReconnect(integrationId: string, row: ProviderAccount): boolean {
    if (keyRejected(row)) return true;
    return keptByPlatform(row) && this.snapshot?.get(integrationId)?.get(row.accountId) === false;
  }

  /** 资源库 / 面板上的「连接状态」:现问平台。存着但对方不认了 = 要重连(❌ 说成登录问题)。 */
  async check(integrationId: string): Promise<PlatformConnectionCheck> {
    const answered = await this.refresh({ maxAgeMs: 0 });
    const accounts = answered ? this.snapshot?.get(integrationId) : undefined;
    if (accounts && [...accounts.values()].some(Boolean)) return { connected: true };
    if (accounts && accounts.size > 0) {
      return { connected: false, errorType: 'authorization_expired', error: new PlatformCredentialRejectedError(integrationId).message };
    }
    // 被拒的那把 key、还留着没搬成的那把,都是这台设备自己知道的事:问没问到平台都照说。
    const rows = await this.deps.accounts.listAccounts(integrationId);
    if (rows.some(keyRejected)) return keyRejectedCheck(this.provider(integrationId)?.name ?? integrationId);
    for (const row of rows) {
      const held = this.heldKeyUnavailable(integrationId, row);
      if (held) return held;
    }
    if (!answered) return this.unansweredCheck(integrationId);
    return { connected: false };
  }

  async checkAccounts(
    integrationId: string
  ): Promise<{ accountId: string; connected: boolean; error?: string; errorType?: IntegrationError['type'] }[]> {
    const answered = await this.refresh({ maxAgeMs: 0 });
    const known = this.snapshot?.get(integrationId);
    return (await this.deps.accounts.listAccounts(integrationId)).map((row) => {
      const connected = answered ? known?.get(row.accountId) : undefined;
      if (connected) return { accountId: row.accountId, connected: true };
      if (connected === false) {
        return { accountId: row.accountId, connected: false, errorType: 'authorization_expired', error: new PlatformCredentialRejectedError(integrationId).message };
      }
      if (keyRejected(row)) return { accountId: row.accountId, ...keyRejectedCheck(this.provider(integrationId)?.name ?? integrationId) };
      const held = this.heldKeyUnavailable(integrationId, row);
      if (held) return { accountId: row.accountId, ...held };
      if (!answered) return { accountId: row.accountId, ...this.unansweredCheck(integrationId) };
      return { accountId: row.accountId, connected: false };
    });
  }

  /** 表单交给平台;平台验过、存下了,本机只记一行(没有密钥)。`editing`:「编辑凭据」—— 本机没有存着的可沿用,留空就是缺。 */
  connect(integrationId: string, input: IntegrationCredentials, options: { editing?: boolean } = {}): Promise<PlatformConnectResult> {
    return this.serialize(async () => {
      const provider = this.provider(integrationId);
      if (!provider) return { success: false, error: `Unknown integration: ${integrationId}` };
      // 这个安装没有这项服务:整件事交回本机保管的老路(编辑时留空 = 沿用本机存着的那份,由老路判断)。
      const client = this.availability === 'absent' ? null : this.client();
      if (!client) {
        await this.serviceMissing(this.deps.providers());
        return { keepHere: true };
      }
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
      // 408 = 请求没及时送到平台:同一个 PUT 再发一次(它是幂等的),❌ 让人当重试。
      for (let attempt = 1; ; attempt += 1) {
        const sentAt = this.now();
        try {
          await client.saveCredential(integrationId, fields, { connect: 'manual' });
          this.availability = 'present';
          break;
        } catch (error) {
          const failure = failureOf(error);
          if (failure.code === 'request_timeout' && attempt === 1) continue;
          // 这个安装没有这项服务:唯一留在本机的情况。别的「不成」(含 503 not_open、超时、限流)照实说,❌ 改存本机。
          if (isPlatformServiceMissing(error)) {
            await this.serviceMissing(this.deps.providers());
            return { keepHere: true };
          }
          // 这台先放手了(或网断了):平台可能已经存下,先重读一次列表再说。
          if (failure.code === 'network' && (await this.keptAfterAll(client, integrationId, sentAt))) {
            this.availability = 'present';
            break;
          }
          if (failure.code === 'not_open') this.availability = 'present';
          this.deps.log.warn('The Gugu platform did not keep the credential', { provider: integrationId, code: failure.code, status: failure.status });
          return connectFailure(error, provider.name, secrets);
        }
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
      this.clearBackOff(integrationId);
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
        await this.client()?.deleteCredential(integrationId);
      } catch (error) {
        const failure = failureOf(error);
        // 没有这项服务 / 还没对他开放(平台上也就不可能替他存着):只剩本机的要删。
        if (failure.code !== 'not_open' && !isPlatformServiceMissing(error)) {
          this.deps.log.warn('The Gugu platform did not remove the credential', { provider: integrationId, code: failure.code, status: failure.status });
          return { success: false, error: `Could not disconnect ${provider.name} on the Gugu platform: ${failure.message}` };
        }
      }
      await this.deps.accounts.removeAllAccounts(integrationId);
      this.snapshot?.set(integrationId, new Map());
      this.clearBackOff(integrationId);
      return { success: true };
    });
  }

  /**
   * 会话里这一家那台 MCP 每次调用现取的转发口:平台的地址 + 本人此刻的会话令牌,凭据由平台挂上。
   * 转发口说没存 / 存着的被拒了 → 这一次调用明确失败,本机也跟着去问一次平台。
   */
  async mcpEndpoint(integrationId: string, signal?: AbortSignal): Promise<IntegrationEndpoint> {
    signal?.throwIfAborted();
    const client = this.client();
    if (!client) throw new Error(`${integrationId} is kept on this computer here; there is no platform forwarder.`);
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
