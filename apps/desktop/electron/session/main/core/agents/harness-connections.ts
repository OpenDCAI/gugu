import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { shareClaudeConfig } from './claude-shared-config';
import { activateCodexAccount, codexCredentialRoot, ensureCodexVault, type CodexAuthSlotPaths } from './codex-auth-slot';
import { CODEX_CONNECTION_UNSET_ENV, codexApiKeyConnectionArgs, connectionLaunchConfig } from './harness-connection-launch';

const namespace = (providerId: string) => `harness:${providerId}`;

function supported(providerId: string): asserts providerId is 'claude' | 'codex' {
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
  if (input.providerId === 'codex') {
    // Codex 会话都跑在用户自己的根上;账号连接只需要一个保管凭据、能独立登录的目录,API 连接什么目录都不要。
    if (input.kind === 'account') await ensureCodexVault(codexVaultRoot(id));
  } else {
    const launch = connectionLaunchConfig(
      input.providerId,
      id,
      input.kind,
      connectionHome(input.providerId, id),
      input.apiKey,
      endpoint
    );
    await mkdir(launch.configDir, { recursive: true, mode: 0o700 });
    if (launch.config)
      await writeFile(join(launch.configDir, 'config.toml'), launch.config, { mode: 0o600, flag: 'wx' });
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
  if (providerId === 'codex') {
    // Codex 照 cockpit-tools(#26):已有会话跟着默认订阅走,❌ 冻结在旧连接上。账号连接把凭据换进用户根;
    // API 连接靠环境变量与 `-c` 起,用户根里的账号原样留着(换回那个账号时它就是最新的那份)。
    if ((target.meta?.harnessConnection?.kind ?? 'native') !== 'api-key') {
      await activateCodexAccount(codexSlotPaths(options.nativeEnv), await codexAccountConnectionIds(), connectionId);
    }
    await registry.setDefaultAccount(namespace(providerId), connectionId);
    return;
  }
  const current = (await registry.getDefaultAccountId(namespace(providerId))) ?? 'native';
  // Existing sessions predate connection binding. Freeze their previous selection before switching.
  db.transaction((tx) => {
    const rows = tx.select().from(sessions).where(eq(sessions.provider, providerId)).all();
    const byId = new Map(rows.map((row) => [row.id, row]));
    const previousConnection = (row: typeof rows[number], seen = new Set<string>()): string => {
      if (row.config?.subscriptionConnectionId) return row.config.subscriptionConnectionId;
      if (seen.has(row.id)) throw new Error('Session fork lineage contains a cycle');
      seen.add(row.id);
      const parent = byId.get(row.config?.forkedFrom?.sessionId ?? '');
      return parent ? previousConnection(parent, seen) : current;
    };
    for (const row of rows) {
      const config: NonNullable<typeof row.config> = row.config ?? { version: '1' as const, type: row.runtime === 'acp' ? 'acp' as const : 'pty' as const };
      if (config.subscriptionConnectionId) continue;
      tx.update(sessions)
        .set({ config: { ...config, subscriptionConnectionId: previousConnection(row) } })
        .where(eq(sessions.id, row.id))
        .run();
    }
  });
  await registry.setDefaultAccount(namespace(providerId), connectionId);
}

export async function removeHarnessConnection(providerId: string, connectionId: string): Promise<void> {
  supported(providerId);
  if (connectionId === 'native') throw new Error('The existing CLI configuration cannot be removed');
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
  if (target.isDefault) throw new Error('Select another connection before removing this one');
  // Keep credentials for bound sessions. Removing a list entry must never reassign a session's billing identity.
  await registry.upsertAccount({
    providerId: namespace(providerId),
    accountId: connectionId,
    meta: { ...target.meta, harnessConnection: { ...target.meta!.harnessConnection!, removed: true } },
  });
}

function connectionHome(providerId: string, id: string): string {
  return join(app.getPath('userData'), 'harness-connections', providerId, id);
}

/** 用户自己的配置根:用户导出了 `CLAUDE_CONFIG_DIR` / `CODEX_HOME` 就是那里,否则 `~/.claude` / `~/.codex`。 */
function nativeConfigRoot(providerId: 'claude' | 'codex', env: Record<string, string | undefined> = process.env): string {
  const home = requireNativeHome(providerId);
  return env[home.envVar]?.trim() || join(homedir(), home.userPath);
}

function codexVaultRoot(id: string): string {
  return join(connectionHome('codex', id), requireNativeHome('codex').userPath);
}

function codexSlotPaths(env?: Record<string, string | undefined>): CodexAuthSlotPaths {
  return {
    nativeRoot: nativeConfigRoot('codex', env),
    vaultRoot: codexVaultRoot,
    backupDir: join(app.getPath('userData'), 'harness-connections', 'codex', 'unrecognized-sign-ins'),
  };
}

/** 能把凭据换进用户根的连接:`native` 与账号连接(含已从列表移除的 —— 它的凭据仍归它)。 */
async function codexAccountConnectionIds(): Promise<string[]> {
  return (await registry.listAccounts(namespace('codex')))
    .filter((row) => (row.meta?.harnessConnection?.kind ?? 'native') !== 'api-key')
    .map((row) => row.accountId);
}

type SessionRow = typeof sessions.$inferSelect;

function sessionRow(id: string): SessionRow | undefined {
  return db.select().from(sessions).where(eq(sessions.id, id)).get();
}

async function resolveCodexConnection(input: {
  connectionId?: string;
  sessionId?: string;
  sourceSessionId?: string;
  nativeEnv?: Record<string, string | undefined>;
}): Promise<Partial<AgentRunContext>> {
  const forSession = Boolean(input.sessionId) || !input.connectionId;
  const id = input.sessionId || !input.connectionId
    ? (await registry.getDefaultAccountId(namespace('codex'))) ?? 'native'
    : input.connectionId;
  const account = await registry.getAccount(namespace('codex'), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  const details = account.meta?.harnessConnection ?? { kind: 'native' as const };
  if (details.kind === 'api-key') {
    const secret = await registry.resolveSecret(namespace('codex'), id);
    if (!secret) throw new Error('The connection’s API key is unavailable');
    return {
      connectionId: id,
      credentialEnv: { OPENAI_API_KEY: secret },
      unsetEnv: [...CODEX_CONNECTION_UNSET_ENV],
      extraArgs: codexApiKeyConnectionArgs(id, details.endpoint),
    };
  }
  const unset = details.kind === 'account' ? { unsetEnv: [...CODEX_CONNECTION_UNSET_ENV] } : {};
  // 会话、模型目录探针、主读数:恒在用户根上跑。只有按连接问的(登录、登录状态、用量)才可能去保管目录 ——
  // 这个账号此刻不在用户根里时,保管目录那份才是它最新的凭据。
  if (forSession || (await codexCredentialRoot(codexSlotPaths(input.nativeEnv), await codexAccountConnectionIds(), id)) === 'native') {
    return { connectionId: id, ...unset };
  }
  await ensureCodexVault(codexVaultRoot(id));
  return {
    connectionId: id,
    credentialHome: connectionHome('codex', id),
    configRootEnv: { CODEX_HOME: codexVaultRoot(id) },
    ...unset,
  };
}

/** Claude 会话钉在创建时的连接上;非原生连接有自己的配置根,用户的配置接进去(#26)。 */
async function pinnedConnectionContext(
  providerId: 'claude',
  id: string,
  nativeEnv?: Record<string, string | undefined>
): Promise<Partial<AgentRunContext>> {
  const account = await registry.getAccount(namespace(providerId), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  const details = account.meta?.harnessConnection;
  if (!details || details.kind === 'native') return { connectionId: 'native' };
  const secret =
    details.kind === 'api-key' ? await registry.resolveSecret(namespace(providerId), id) : undefined;
  if (details.kind === 'api-key' && !secret) throw new Error('The connection’s API key is unavailable');
  const home = connectionHome(providerId, id);
  const launch = connectionLaunchConfig(
    providerId,
    id,
    details.kind,
    home,
    secret ?? undefined,
    details.endpoint
  );
  const nativeRoot = nativeConfigRoot('claude', nativeEnv);
  const exported = Boolean((nativeEnv ?? process.env).CLAUDE_CONFIG_DIR?.trim());
  await shareClaudeConfig({
    nativeRoot,
    nativeGlobalConfig: exported ? join(nativeRoot, '.claude.json') : join(homedir(), '.claude.json'),
    connectionRoot: launch.configDir,
  });
  const rootKey = requireNativeHome(providerId).envVar;
  const { [rootKey]: configRoot, ...credentialEnv } = launch.env;
  return { connectionId: id, credentialHome: home, configRootEnv: { [rootKey]: configRoot }, credentialEnv, unsetEnv: launch.unsetEnv };
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
  } = {},
  visited = new Set<string>()
): Promise<Partial<AgentRunContext>> {
  if (providerId !== 'claude' && providerId !== 'codex') return {};
  await ensureNative(providerId);
  if (providerId === 'codex') return resolveCodexConnection(input);
  let id = input.connectionId;
  if (input.sessionId) {
    if (visited.has(input.sessionId)) throw new Error('Session fork lineage contains a cycle');
    visited.add(input.sessionId);
    const row = db.select().from(sessions).where(eq(sessions.id, input.sessionId)).get();
    if (!row && input.sourceSessionId && input.sourceSessionId !== input.sessionId) {
      return resolveHarnessConnection(providerId, { sessionId: input.sourceSessionId, nativeEnv: input.nativeEnv }, visited);
    }
    if (!row || row.provider !== providerId) throw new Error('Session connection cannot be resolved');
    const sourceId = row.config?.forkedFrom?.sessionId;
    const inherited = !row.config?.subscriptionConnectionId && sourceId && sourceId !== row.id
      ? await resolveHarnessConnection(providerId, { sessionId: sourceId, nativeEnv: input.nativeEnv }, visited)
      : undefined;
    id = db.transaction((tx) => {
      const row = tx.select().from(sessions).where(eq(sessions.id, input.sessionId!)).get();
      if (!row || row.provider !== providerId) throw new Error('Session connection cannot be resolved');
      if (row.config?.subscriptionConnectionId) return row.config.subscriptionConnectionId;
      // The registry is local SQLite too; selection and binding cannot interleave within this synchronous transaction.
      return inherited?.connectionId;
    });
  }
  const account = await registry.getAccount(namespace(providerId), id);
  if (!account) throw new Error('The session’s subscription connection is unavailable');
  id = account.accountId;
  if (input.sessionId) {
    id = db.transaction((tx) => {
      const row = tx.select().from(sessions).where(eq(sessions.id, input.sessionId!)).get();
      if (!row) throw new Error('Session no longer exists');
      const config: NonNullable<typeof row.config> = row.config ?? { version: '1' as const, type: row.runtime === 'acp' ? 'acp' as const : 'pty' as const };
      if (config.subscriptionConnectionId) return config.subscriptionConnectionId;
      tx.update(sessions)
        .set({ config: { ...config, subscriptionConnectionId: id } })
        .where(eq(sessions.id, row.id))
        .run();
      return id!;
    });
  }
  return pinnedConnectionContext(providerId, id!, input.nativeEnv);
}

/**
 * 升级对齐(#26):修复前 Codex 账号连接的凭据只在它自己的目录里,默认订阅是它、用户根里却是另一个账号。
 * 只在还没有 Codex 会话跑起来的时候调(开机)。默认是原生连接时不动:那就是用户在 CLI 里登录的那个。
 */
export async function alignCodexDefaultAccount(nativeEnv?: Record<string, string | undefined>): Promise<void> {
  await ensureNative('codex');
  const id = await registry.getDefaultAccountId(namespace('codex'));
  if (!id || id === 'native') return;
  const account = await registry.getAccount(namespace('codex'), id);
  if (account?.meta?.harnessConnection?.kind !== 'account') return;
  const paths = codexSlotPaths(nativeEnv);
  const ids = await codexAccountConnectionIds();
  if ((await codexCredentialRoot(paths, ids, id)) === 'native') return;
  await activateCodexAccount(paths, ids, id);
}

/** An event must be attributed to the account the session actually ran on, never a guess. */
export async function sessionHarnessConnectionId(sessionId: string | undefined): Promise<string | undefined> {
  if (!sessionId) return undefined;
  const row = sessionRow(sessionId);
  if (!row) return undefined;
  if (row.provider === 'codex') {
    // Codex 会话跟默认订阅走:跑的就是此刻用户根里的账号 = 当前默认连接(#26)。
    return (await registry.getDefaultAccountId(namespace('codex'))) ?? 'native';
  }
  return row.config?.subscriptionConnectionId ?? 'native';
}
