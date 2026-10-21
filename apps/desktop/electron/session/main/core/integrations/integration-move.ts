// #7199 助理搬家:它在这台机器上连着的「账号类」服务(邮箱、飞书、Notion、GitHub……)的授权,跟着它搬到新家。
// 只管凭据本身 —— 官方命令行那两家(钉钉 / 企业微信)的登录态在那台机器的命令行目录里,带不走,搬完要在新家重新连;
// 靠 gh 命令行登录、本机没存密钥的 GitHub 账号同理。这些都**不静默丢**:导出时逐条说清「没带」和原因。
// 导入是照原样写进新家的账号表,❌ 联网校验(搬运不该因为对方服务一时连不上就丢账号);连得上连不上,新家的资源库页自己会查。
import type { IntegrationCredentials } from '@gugu/session-plugins/integrations';
import type {
  IntegrationMoveExport,
  IntegrationMoveImport,
  MovableIntegrationAccount,
  MoveSkipped,
} from '@shared/core/integrations/integration-move';

export type {
  IntegrationMoveExport,
  IntegrationMoveImport,
  MovableIntegrationAccount,
  MoveSkipReason,
  MoveSkipped,
} from '@shared/core/integrations/integration-move';

export type IntegrationMoveDeps = {
  integrationIds(): string[];
  isCli(integrationId: string): boolean;
  hasIntegration(integrationId: string): boolean;
  listAccounts(integrationId: string): Promise<{
    accounts: { accountId: string; displayName?: string; isDefault: boolean; credentials: IntegrationCredentials }[];
    unreadable: string[];
  }>;
  upsertAccount(
    integrationId: string,
    account: { accountId: string; displayName?: string; credentials: IntegrationCredentials }
  ): Promise<void>;
  setDefault(integrationId: string, accountId: string): Promise<boolean>;
};

export async function exportAccountsForMove(deps: IntegrationMoveDeps): Promise<IntegrationMoveExport> {
  const accounts: MovableIntegrationAccount[] = [];
  const skipped: MoveSkipped[] = [];
  for (const integrationId of deps.integrationIds()) {
    const listed = await deps.listAccounts(integrationId);
    if (deps.isCli(integrationId)) {
      // 命令行那几家记的只是「连过」,一条记录就够说明「这一家搬完要重新连」。
      if (listed.accounts.length > 0 || listed.unreadable.length > 0) skipped.push({ integrationId, reason: 'cli' });
      continue;
    }
    for (const account of listed.accounts) {
      accounts.push({
        integrationId,
        accountId: account.accountId,
        ...(account.displayName ? { displayName: account.displayName } : {}),
        isDefault: account.isDefault,
        credentials: account.credentials,
      });
    }
    for (const accountId of listed.unreadable) skipped.push({ integrationId, accountId, reason: 'no-secret' });
  }
  return { accounts, skipped };
}

/** 凭据是否同一份(键序无关);搬运的幂等 / 冲突判断用。 */
function sameCredentials(a: IntegrationCredentials, b: IntegrationCredentials): boolean {
  const canon = (value: unknown): string =>
    Array.isArray(value)
      ? `[${value.map(canon).join(',')}]`
      : value && typeof value === 'object'
        ? `{${Object.keys(value as Record<string, unknown>)
            .sort()
            .map((key) => `${JSON.stringify(key)}:${canon((value as Record<string, unknown>)[key])}`)
            .join(',')}}`
        : JSON.stringify(value);
  return canon(a) === canon(b);
}

export async function importAccountsFromMove(
  deps: IntegrationMoveDeps,
  incoming: readonly MovableIntegrationAccount[]
): Promise<IntegrationMoveImport> {
  const skipped: MoveSkipped[] = [];
  let imported = 0;
  const written: MovableIntegrationAccount[] = [];
  const defaults = new Map<string, string>();
  const existing = new Map<string, Map<string, IntegrationCredentials>>();
  const existingOf = async (integrationId: string) => {
    let known = existing.get(integrationId);
    if (!known) {
      known = new Map((await deps.listAccounts(integrationId)).accounts.map((a) => [a.accountId, a.credentials]));
      existing.set(integrationId, known);
    }
    return known;
  };
  for (const account of incoming) {
    if (!deps.hasIntegration(account.integrationId)) {
      skipped.push({ integrationId: account.integrationId, accountId: account.accountId, reason: 'unknown-integration' });
      continue;
    }
    if (deps.isCli(account.integrationId)) {
      skipped.push({ integrationId: account.integrationId, accountId: account.accountId, reason: 'cli' });
      continue;
    }
    // 新家已经连着同一个 id 的另一份凭据(人在两头各自连过同一家):不覆盖 —— 覆盖就把新家原来那个账号弄没了。
    // 同一份凭据 = 上一次搬到一半留下的,当作已经搬过(幂等),照常往下走(旧家那份由编排核对后撤)。
    const present = (await existingOf(account.integrationId)).get(account.accountId);
    if (present && !sameCredentials(present, account.credentials)) {
      skipped.push({ integrationId: account.integrationId, accountId: account.accountId, reason: 'exists' });
      continue;
    }
    await deps.upsertAccount(account.integrationId, {
      accountId: account.accountId,
      ...(account.displayName ? { displayName: account.displayName } : {}),
      credentials: account.credentials,
    });
    imported += 1;
    written.push(account);
    if (account.isDefault) defaults.set(account.integrationId, account.accountId);
  }
  // 写完读回来对一遍:对不上就响亮失败(搬家这一步重来),❌ 让编排以为搬好了去撤旧家那一份。
  const readBack = new Map<string, Map<string, IntegrationCredentials>>();
  for (const account of written) {
    let stored = readBack.get(account.integrationId);
    if (!stored) {
      stored = new Map((await deps.listAccounts(account.integrationId)).accounts.map((a) => [a.accountId, a.credentials]));
      readBack.set(account.integrationId, stored);
    }
    const got = stored.get(account.accountId);
    if (!got || !sameCredentials(got, account.credentials)) {
      throw new Error(`credential read-back mismatch for ${account.integrationId}/${account.accountId}`);
    }
  }
  // 「谁是默认」放到最后一并落:账号表对「第一个写进去的当默认」,搬过来的次序不该决定它。
  for (const [integrationId, accountId] of defaults) await deps.setDefault(integrationId, accountId);
  return { imported, skipped };
}

/**
 * 确认框要列「这次会带走哪些账号」:只要名字,不含任何密钥 —— 凭据不离开主进程(真正搬的时候才经设备通道走)。
 * `reconnect` = 带不走、搬完要在新家重新连的(命令行那几家、本机没存密钥的账号)。
 */
export async function previewAccountsForMove(deps: IntegrationMoveDeps): Promise<{
  moving: { integrationId: string; accountId: string; displayName?: string }[];
  reconnect: MoveSkipped[];
}> {
  const exported = await exportAccountsForMove(deps);
  return {
    moving: exported.accounts.map(({ integrationId, accountId, displayName }) => ({
      integrationId,
      accountId,
      ...(displayName ? { displayName } : {}),
    })),
    reconnect: exported.skipped,
  };
}
