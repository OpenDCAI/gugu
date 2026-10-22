import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { eq } from 'drizzle-orm';
import { requireNativeHome } from '@gugu/session-plugins/agents';
import type { AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import type {
  CreateHarnessConnection,
  HarnessConnection,
} from '@gugu/session-core/workspace-server/agent-config';
import { providerAccountRegistry as registry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { activateClaudeAccount, claudeCredentialRoot, ensureClaudeVault, type ClaudeAuthSlotPaths } from './claude-auth-slot';
import { createClaudeCredentialStore, type ClaudeCredentialStore } from './claude-credential-store';
import { moveClaudeHistoryToUserRoot } from './claude-history-move';
import { activateCodexAccount, codexCredentialRoot, ensureCodexVault, type CodexAuthSlotPaths } from './codex-auth-slot';
import {
  CLAUDE_CONNECTION_UNSET_ENV,
  CODEX_CONNECTION_UNSET_ENV,
  claudeApiKeyEnv,
  codexApiKeyConnectionArgs,
} from './harness-connection-launch';

/**
 * 订阅连接(#26,照 cockpit-tools):两家的会话都跑在用户自己的配置根上(`~/.claude` / `~/.codex`,
 * 或用户导出的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`),所有会话跟着默认连接走,❌ 钉在创建时的连接上。
 * 账号连接 = 一个保管目录,存这个账号的登录、能独立登录和读用量;选中它 = 把它的凭据换进用户根。
 * API 连接只在启动时给环境变量,用户根里的账号原样留着。
 */

type Provider = 'claude' | 'codex';

const namespace = (providerId: string) => `harness:${providerId}`;

function supported(providerId: string): asserts providerId is Provider {
  if (providerId !== 'claude' && providerId !== 'codex')
    throw new Error('Connection management is unavailable for this harness');
}

async function ensureNative(providerId: string): Promise<void> {
  if (await registry.getAccount(namespace(providerId), 'native')) return;
  await registry.upsertAccount({
    providerId: namespace(providerId),
    accountId: 'native',
    meta: { harnessConnection: { kind: 'native' } },
  });
}

export async function listHarnessConnections(providerId: string): Promise<HarnessConnection[]> {
  supported(providerId);
  await ensureNative(providerId);
  return (await registry.listAccounts(namespace(providerId)))
    .filter((row) => !row.meta?.harnessConnection?.removed)
    .map((row) => ({
      id: row.accountId,
      kind: row.meta?.harnessConnection?.kind ?? 'native',
      name: row.meta?.displayName ?? '',
      endpoint: row.meta?.harnessConnection?.endpoint,
      current: row.isDefault,
    }));
}

export async function createHarnessConnection(input: CreateHarnessConnection): Promise<HarnessConnection> {
  supported(input.providerId);
  await ensureNative(input.providerId);
  const id = randomUUID();
  const endpoint = input.endpoint?.replace(/\/+$/, '');
  const rows = await listHarnessConnections(input.providerId);
  const name =
    input.name ||
    (endpoint
      ? new URL(endpoint).host
      : `${input.providerId === 'claude' ? 'Claude' : 'Codex'} ${rows.length}`);
  // 账号连接只需要一个保管凭据、能独立登录的目录;API 连接什么目录都不要。
  if (input.kind === 'account') {
    if (input.providerId === 'codex') await ensureCodexVault(vaultRoot('codex', id));
    else await ensureClaudeVault(vaultRoot('claude', id));
  }
  await registry.upsertAccount({
    providerId: namespace(input.providerId),
    accountId: id,
    ...(input.apiKey ? { secret: input.apiKey } : {}),
    meta: { displayName: name, harnessConnection: { kind: input.kind, ...(endpoint ? { endpoint } : {}) } },
  });
  return { id, name, kind: input.kind, endpoint, current: false };
}

export async function selectHarnessConnection(
  providerId: string,
  connectionId: string,
  options: { nativeEnv?: Record<string, string | undefined> } = {}
): Promise<void> {
  supported(providerId);
  await ensureNative(providerId);
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  // 已有会话跟着默认订阅走。账号连接把凭据换进用户根;API 连接靠环境变量起,
  // 用户根里的账号原样留着(换回那个账号时它就是最新的那份)。
  if ((target.meta?.harnessConnection?.kind ?? 'native') !== 'api-key') {
    const current = await defaultConnectionId(providerId);
    const ids = await accountConnectionIds(providerId);
    if (providerId === 'codex') await activateCodexAccount(codexSlotPaths(options.nativeEnv), ids, connectionId, current);
    else await activateClaudeAccount(claudeSlotPaths(options.nativeEnv), ids, connectionId, current);
  }
  await registry.setDefaultAccount(namespace(providerId), connectionId);
}

export async function removeHarnessConnection(providerId: string, connectionId: string): Promise<void> {
  supported(providerId);
  if (connectionId === 'native') throw new Error('The existing CLI configuration cannot be removed');
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  if (target.isDefault) throw new Error('Select another connection before removing this one');
  // 只从列表里拿掉:保管目录里的登录仍归它,用户根里要是正好是它的账号,换走时还得写回去。
  await registry.upsertAccount({
    providerId: namespace(providerId),
    accountId: connectionId,
    meta: { ...target.meta, harnessConnection: { ...target.meta!.harnessConnection!, removed: true } },
  });
}

function connectionHome(providerId: Provider, id: string): string {
  return join(app.getPath('userData'), 'harness-connections', providerId, id);
}

/** 连接的保管目录:布局与用户根相同(`<连接 home>/.claude` / `.codex`),登录与用量读取以它为配置根。 */
function vaultRoot(providerId: Provider, id: string): string {
  return join(connectionHome(providerId, id), requireNativeHome(providerId).userPath);
}

/**
 * 单一目录之前,Claude 账号 / API 连接上的会话跑在连接自己的配置根里,记录也在那里(就是今天的保管目录)。
 * 开机时已搬进用户根;这里留给读记录的一侧做兜底(搬失败的、或还没开过机的)。原生连接与 Codex ⇒ null。
 */
export function connectionConfigRoot(providerId: string, connectionId: string): string | null {
  if (providerId !== 'claude' || connectionId === 'native') return null;
  return vaultRoot('claude', connectionId);
}

/** 用户自己的配置根:用户导出了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 就是那里,否则 `~/.claude` / `~/.codex`。 */
function nativeConfigRoot(providerId: Provider, env: Record<string, string | undefined> = process.env): string {
  const home = requireNativeHome(providerId);
  return env[home.envVar]?.trim() || join(homedir(), home.userPath);
}

function codexSlotPaths(env?: Record<string, string | undefined>): CodexAuthSlotPaths {
  return {
    nativeRoot: nativeConfigRoot('codex', env),
    vaultRoot: (id) => vaultRoot('codex', id),
    backupDir: join(app.getPath('userData'), 'harness-connections', 'codex', 'unrecognized-sign-ins'),
  };
}

let claudeStore: ClaudeCredentialStore | null = null;

function claudeSlotPaths(env: Record<string, string | undefined> = process.env): ClaudeAuthSlotPaths {
  // 用户导出了 `CLAUDE_CONFIG_DIR`:`.claude.json` 在那个根里,钥匙串条目名带这个根的哈希;否则在 home 下、不带。
  const exported = Boolean(env.CLAUDE_CONFIG_DIR?.trim());
  const nativeRoot = nativeConfigRoot('claude', env);
  claudeStore ??= createClaudeCredentialStore();
  return {
    nativeRoot,
    nativeGlobalConfig: exported ? join(nativeRoot, '.claude.json') : join(homedir(), '.claude.json'),
    nativeSuffixed: exported,
    vaultRoot: (id) => vaultRoot('claude', id),
    backupDir: join(app.getPath('userData'), 'harness-connections', 'claude', 'unrecognized-sign-ins'),
    store: claudeStore,
  };
}

async function defaultConnectionId(providerId: Provider): Promise<string> {
  return (await registry.getDefaultAccountId(namespace(providerId))) ?? 'native';
}

/** 能把凭据换进用户根的连接:`native` 与账号连接(含已从列表移除的 —— 它的凭据仍归它)。 */
async function accountConnectionIds(providerId: Provider): Promise<string[]> {
  return (await registry.listAccounts(namespace(providerId)))
    .filter((row) => (row.meta?.harnessConnection?.kind ?? 'native') !== 'api-key')
    .map((row) => row.accountId);
}

async function credentialRoot(
  providerId: Provider,
  connectionId: string,
  nativeEnv?: Record<string, string | undefined>
): Promise<'native' | 'vault'> {
  const ids = await accountConnectionIds(providerId);
  const selected = await defaultConnectionId(providerId);
  return providerId === 'codex'
    ? codexCredentialRoot(codexSlotPaths(nativeEnv), ids, connectionId, selected)
    : claudeCredentialRoot(claudeSlotPaths(nativeEnv), ids, connectionId, selected);
}

/** Resolved exclusively on the credential-owning machine, never in a renderer. */
export async function resolveHarnessConnection(
  providerId: string,
  input: {
    connectionId?: string;
    sessionId?: string;
    sourceSessionId?: string;
    /** 解析「用户自己的配置根」用的 env(含用户 shell 里导出的 `CLAUDE_CONFIG_DIR` / `CODEX_HOME`)。 */
    nativeEnv?: Record<string, string | undefined>;
  } = {}
): Promise<Partial<AgentRunContext>> {
  if (providerId !== 'claude' && providerId !== 'codex') return {};
  await ensureNative(providerId);
  // 会话(不论哪条、什么时候建的)和不指名的读取跟默认连接走;只有按连接问的(登录、登录状态、用量)才指名。
  const forSession = Boolean(input.sessionId) || !input.connectionId;
  const id = forSession ? await defaultConnectionId(providerId) : input.connectionId!;
  const account = await registry.getAccount(namespace(providerId), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  const details = account.meta?.harnessConnection ?? { kind: 'native' as const };
  const unsetEnv = providerId === 'codex' ? [...CODEX_CONNECTION_UNSET_ENV] : [...CLAUDE_CONNECTION_UNSET_ENV];
  if (details.kind === 'api-key') {
    const secret = await registry.resolveSecret(namespace(providerId), id);
    if (!secret) throw new Error('The connection’s API key is unavailable');
    return providerId === 'codex'
      ? { connectionId: id, credentialEnv: { OPENAI_API_KEY: secret }, unsetEnv, extraArgs: codexApiKeyConnectionArgs(id, details.endpoint) }
      : { connectionId: id, credentialEnv: claudeApiKeyEnv(secret, details.endpoint), unsetEnv };
  }
  const unset = details.kind === 'account' ? { unsetEnv } : {};
  // 会话、模型目录探针、主读数:恒在用户根上跑。按连接问的,这个账号此刻不在用户根里时,保管目录那份才是它最新的凭据。
  if (forSession || (await credentialRoot(providerId, id, input.nativeEnv)) === 'native') {
    return { connectionId: id, ...unset };
  }
  if (providerId === 'codex') await ensureCodexVault(vaultRoot(providerId, id));
  else await ensureClaudeVault(vaultRoot(providerId, id));
  return {
    connectionId: id,
    credentialHome: connectionHome(providerId, id),
    configRootEnv: { [requireNativeHome(providerId).envVar]: vaultRoot(providerId, id) },
    ...unset,
  };
}

/**
 * 升级对齐(#26):修复前账号连接的凭据只在它自己的目录里,默认订阅是它、用户根里却是另一个账号。
 * 只在还没有会话跑起来的时候调(开机)。默认是原生 / API 连接时不动:用户根里的就是用户在 CLI 里登录的那个。
 */
async function alignDefaultAccount(providerId: Provider, nativeEnv?: Record<string, string | undefined>): Promise<void> {
  await ensureNative(providerId);
  const id = await defaultConnectionId(providerId);
  if (id === 'native') return;
  const account = await registry.getAccount(namespace(providerId), id);
  if (account?.meta?.harnessConnection?.kind !== 'account') return;
  if ((await credentialRoot(providerId, id, nativeEnv)) === 'native') return;
  const ids = await accountConnectionIds(providerId);
  if (providerId === 'codex') await activateCodexAccount(codexSlotPaths(nativeEnv), ids, id, id);
  else await activateClaudeAccount(claudeSlotPaths(nativeEnv), ids, id, id);
}

export async function alignCodexDefaultAccount(nativeEnv?: Record<string, string | undefined>): Promise<void> {
  await alignDefaultAccount('codex', nativeEnv);
}

/** Claude 还要先把连接根里的会话记录搬进用户根(见 `claude-history-move.ts`),一个连接搬不动不拦别的。 */
export async function alignClaudeConnections(nativeEnv?: Record<string, string | undefined>): Promise<void> {
  await ensureNative('claude');
  const nativeRoot = nativeConfigRoot('claude', nativeEnv);
  for (const row of await registry.listAccounts(namespace('claude'))) {
    if (row.accountId === 'native') continue;
    try {
      if (await moveClaudeHistoryToUserRoot(vaultRoot('claude', row.accountId), nativeRoot)) {
        log.info('harness connections: moved Claude session history into the user root', { connectionId: row.accountId });
      }
    } catch (error) {
      log.warn('harness connections: could not move Claude session history; it stays readable from the connection root', {
        connectionId: row.accountId,
        error: String(error),
      });
    }
  }
  await alignDefaultAccount('claude', nativeEnv);
}

/** 开机时、任何会话起来之前调一次(embedded-boot)。一家对不齐不拦另一家。 */
export async function alignHarnessConnectionsAtStartup(): Promise<void> {
  const { resolveLocalAgentSpawnEnv } = await import('./agent-run-context');
  const failures: unknown[] = [];
  for (const [providerId, align] of [['codex', alignCodexDefaultAccount], ['claude', alignClaudeConnections]] as const) {
    try {
      await align(await resolveLocalAgentSpawnEnv(providerId));
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'harness connections: startup alignment failed');
}

/** An event must be attributed to the account the session actually ran on, never a guess. */
export async function sessionHarnessConnectionId(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const row = db.select().from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row) return undefined;
  // 两家的会话都跟默认订阅走:跑的就是此刻用户根里的账号 = 当前默认连接(#26)。
  if (row.provider === 'codex' || row.provider === 'claude') return defaultConnectionId(row.provider);
  return 'native';
}
