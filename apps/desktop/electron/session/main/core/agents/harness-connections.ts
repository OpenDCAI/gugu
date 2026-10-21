import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
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
import { connectionLaunchConfig } from './harness-connection-launch';

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
  await registry.upsertAccount({
    providerId: namespace(input.providerId),
    accountId: id,
    ...(input.apiKey ? { secret: input.apiKey } : {}),
    meta: { displayName: name, harnessConnection: { kind: input.kind, ...(endpoint ? { endpoint } : {}) } },
  });
  return { id, name, kind: input.kind, endpoint, current: false };
}

export async function selectHarnessConnection(providerId: string, connectionId: string): Promise<void> {
  supported(providerId);
  await ensureNative(providerId);
  const target = await registry.getAccount(namespace(providerId), connectionId);
  if (!target || target.meta?.harnessConnection?.removed) throw new Error('Connection no longer exists');
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

/** Resolved exclusively on the credential-owning machine, never in a renderer. */
export async function resolveHarnessConnection(
  providerId: string,
  input: { connectionId?: string; sessionId?: string; sourceSessionId?: string } = {},
  visited = new Set<string>()
): Promise<Partial<AgentRunContext>> {
  if (providerId !== 'claude' && providerId !== 'codex') return {};
  await ensureNative(providerId);
  let id = input.connectionId;
  if (input.sessionId) {
    if (visited.has(input.sessionId)) throw new Error('Session fork lineage contains a cycle');
    visited.add(input.sessionId);
    const row = db.select().from(sessions).where(eq(sessions.id, input.sessionId)).get();
    if (!row && input.sourceSessionId && input.sourceSessionId !== input.sessionId) {
      return resolveHarnessConnection(providerId, { sessionId: input.sourceSessionId }, visited);
    }
    if (!row || row.provider !== providerId) throw new Error('Session connection cannot be resolved');
    const sourceId = row.config?.forkedFrom?.sessionId;
    const inherited = !row.config?.subscriptionConnectionId && sourceId && sourceId !== row.id
      ? await resolveHarnessConnection(providerId, { sessionId: sourceId }, visited)
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
    if (id !== account.accountId) return resolveHarnessConnection(providerId, { connectionId: id });
  }
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
  const rootKey = requireNativeHome(providerId).envVar;
  const { [rootKey]: configRoot, ...credentialEnv } = launch.env;
  return { connectionId: id, credentialHome: home, configRootEnv: { [rootKey]: configRoot }, credentialEnv, unsetEnv: launch.unsetEnv };
}

/** An event must be attributed to the session's binding, never the newly selected account. */
export function sessionHarnessConnectionId(sessionId: string | undefined): string | undefined {
  if (!sessionId) return undefined;
  const row = db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).get();
  return row ? row.config?.subscriptionConnectionId ?? 'native' : undefined;
}
