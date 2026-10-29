import { createPlatformIntegrationsClient } from '@gugu/core/cloud/platformIntegrations';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * #921 凭据由平台保管(高德先上):一个人、一个平台、两台设备。每台设备一份真的账号表(各自一个 SQLite),
 * 平台是假的 —— 只照约定回话(`GET /integrations`、`PUT|DELETE …/credential`、`…/mcp` 转发口)。
 * 会话里给不给高德的工具,走的是开会话那一步真的判断(`connectedSessionIntegrations`)。
 */

/** What this device's own credential store holds (only used where the platform has no such service). */
const local = vi.hoisted(() => ({ accounts: new Map<string, Record<string, unknown>>() }));
vi.mock('./integration-credential-store-instance', () => ({
  integrationCredentialStore: { isConfigured: async (id: string) => local.accounts.has(id), listAccounts: async () => [] },
}));
vi.mock('./integration-connection-service', () => ({
  integrationConnectionService: {
    getFreshAccount: async (id: string) => (local.accounts.has(id) ? { accountId: 'default', credentials: local.accounts.get(id) } : null),
  },
}));
vi.mock('./platform-credentials-instance', () => ({ platformCredentials: null }));

const { IntegrationCredentialStore } = await import('./integration-credential-store');
const { PlatformCredentialService, platformCustodyProviders } = await import('./platform-credentials');
const { connectedSessionIntegrations } = await import('./session-integrations');

const BASE = 'https://db.test/functions/v1/cloud-computer';
const GOOD = '0123456789abcdef0123456789abcdef';
const BAD = 'ffffffffffffffffffffffffffffffff';
const AMAP_SECRET_REF = 'provider-credential:amap:default';
const MCP_CALL = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) };

/** The platform, as the contract describes it, for one person. */
function fakePlatform() {
  const saved = new Map<string, { apiKey: string; rejected: boolean }>();
  const requests: Array<{ method: string; path: string; authorization: string | null; body: unknown; raw: string }> = [];
  const state = {
    putFault: null as null | { status: number; code: string },
    onPut: null as null | (() => void),
    /** absent = this installation has no such service (the gateway's 404); closed = not open to this person (503). */
    mode: 'open' as 'open' | 'absent' | 'closed',
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : '';
    const path = url.pathname.replace('/functions/v1/cloud-computer', '');
    requests.push({ method, path, authorization: new Headers(init?.headers).get('authorization'), body: raw ? JSON.parse(raw) : undefined, raw: `${url}${raw}` });
    if (state.mode === 'absent') return Response.json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, { status: 404 });
    if (state.mode === 'closed') return Response.json({ error: 'not_open', message: 'Not open to you yet.' }, { status: 503 });
    if (path === '/integrations' && method === 'GET') {
      const amap = saved.get('amap');
      return Response.json({
        providers: [{
          provider: 'amap',
          accounts: amap ? [{ accountId: 'default', connected: !amap.rejected, updatedAt: '2026-10-29T02:00:00.000Z', checkedAt: '2026-10-29T02:00:01.000Z' }] : [],
        }],
      });
    }
    const credential = /^\/integrations\/([^/]+)\/credential$/.exec(path);
    if (credential && method === 'PUT') {
      state.onPut?.();
      if (state.putFault) return Response.json({ error: state.putFault.code, message: 'Try again later.' }, { status: state.putFault.status });
      const apiKey = (JSON.parse(raw) as { fields?: { apiKey?: string } }).fields?.apiKey;
      // A careless upstream message that repeats the key: the client must not pass it on.
      if (apiKey !== GOOD) return Response.json({ error: 'auth_failed', message: `AMap rejected ${apiKey} (INVALID_USER_KEY)` }, { status: 422 });
      saved.set(credential[1]!, { apiKey, rejected: false });
      return Response.json({ connected: true, updatedAt: '2026-10-29T02:00:00.000Z', checkedAt: '2026-10-29T02:00:01.000Z' });
    }
    if (credential && method === 'DELETE') {
      saved.delete(credential[1]!);
      return new Response(null, { status: 204 });
    }
    const mcp = /^\/integrations\/([^/]+)\/mcp$/.exec(path);
    if (mcp) {
      const stored = saved.get(mcp[1]!);
      if (!stored) return Response.json({ error: 'not_connected', message: 'Nothing is stored for this provider.' }, { status: 404 });
      if (stored.rejected) return Response.json({ error: 'credential_rejected', message: 'The provider rejected the saved credential.' }, { status: 409 });
      return Response.json({ jsonrpc: '2.0', id: 1, result: { tools: [] } });
    }
    return new Response('no such route', { status: 404 });
  }) as typeof fetch;
  return { saved, requests, state, fetchImpl };
}

type Platform = ReturnType<typeof fakePlatform>;
const opened: RegistryFixture[] = [];
afterEach(() => {
  for (const fixture of opened.splice(0)) fixture.close();
  local.accounts.clear();
});

/** One of the person's devices: its own account table, signed in with its own session token. */
async function device(platform: Platform, name: string, clock = { now: 1_000_000 }) {
  const fixture = await openRegistryFixture('empty');
  opened.push(fixture);
  const token = { value: `${name}-session-1` };
  const logs: unknown[] = [];
  const service = new PlatformCredentialService({
    client: () => createPlatformIntegrationsClient({ baseUrl: BASE, accessToken: async () => token.value, anonKey: 'anon', fetch: platform.fetchImpl }),
    accounts: fixture.registry,
    providers: platformCustodyProviders,
    log: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
    now: () => clock.now,
  });
  return { fixture, service, token, logs };
}

async function amapEntry(service: InstanceType<typeof PlatformCredentialService>) {
  const entries = await connectedSessionIntegrations(service);
  return entries.find((entry) => entry.integrationId === 'amap') ?? null;
}

async function endpointOf(entry: NonNullable<Awaited<ReturnType<typeof amapEntry>>>) {
  if (entry.upstream.kind !== 'remote') throw new Error('AMap should be forwarded, not answered locally');
  return entry.upstream.endpoint();
}

describe('credentials the platform keeps (#921)', () => {
  it('connecting sends the key to the platform and keeps no secret on the device', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');

    expect(await a.service.connect('amap', { apiKey: ` ${GOOD} ` })).toEqual({ success: true });

    const put = platform.requests.find((request) => request.method === 'PUT');
    expect(put).toMatchObject({ path: '/integrations/amap/credential', authorization: 'Bearer A-session-1', body: { fields: { apiKey: GOOD } } });
    expect(a.fixture.secretStore.secrets.size).toBe(0);
    const rows = await a.fixture.registry.listAccounts('amap');
    expect(rows.map((row) => [row.accountId, row.meta?.credentialSource])).toEqual([['default', 'platform']]);
    // The library reads the account without reaching for a secret that is not there.
    const warn = vi.fn();
    const store = new IntegrationCredentialStore(a.fixture.registry, noLegacy(), { warn });
    expect((await store.listAccounts('amap')).map(({ accountId, credentials }) => ({ accountId, credentials }))).toEqual([
      { accountId: 'default', credentials: {} },
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a key the provider rejects maps to the existing auth_failed error and is never echoed', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');

    const result = await a.service.connect('amap', { apiKey: BAD });

    expect(result).toMatchObject({ success: false, errorType: 'auth_failed' });
    expect(JSON.stringify(result)).not.toContain(BAD);
    expect(await a.fixture.registry.listAccounts('amap')).toEqual([]);
    expect(a.fixture.secretStore.secrets.size).toBe(0);
    expect(JSON.stringify(a.logs)).not.toContain(BAD);
  });

  it('a second device sees AMap connected, with tools, without connecting there', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');
    const b = await device(platform, 'B');
    await a.service.connect('amap', { apiKey: GOOD });

    expect(await amapEntry(b.service)).not.toBeNull();
    expect(await b.service.check('amap')).toEqual({ connected: true });
    const rows = await b.fixture.registry.listAccounts('amap');
    expect(rows.map((row) => [row.accountId, row.meta?.credentialSource])).toEqual([['default', 'platform']]);
    expect(b.fixture.secretStore.secrets.size).toBe(0);
  });

  it('the session endpoint is the platform forwarder with the person’s current token, and no key on the device', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');
    const b = await device(platform, 'B');
    await a.service.connect('amap', { apiKey: GOOD });
    const entry = await amapEntry(b.service);
    if (!entry) throw new Error('AMap should be handed to the session');

    const first = await endpointOf(entry);
    expect(first.url).toBe(`${BASE}/integrations/amap/mcp`);
    expect(first.headers).toMatchObject({ Authorization: 'Bearer B-session-1' });
    const response = await first.fetch!(first.url, { ...MCP_CALL, headers: first.headers });
    expect(response.status).toBe(200);

    // The token is read on every call: a renewed session token is used from the next call on.
    b.token.value = 'B-session-2';
    const second = await endpointOf(entry);
    expect(second.headers).toMatchObject({ Authorization: 'Bearer B-session-2' });
    const forwarded = platform.requests.filter((request) => request.path === '/integrations/amap/mcp');
    expect(forwarded.every((request) => !request.raw.includes(GOOD))).toBe(true);
  });

  it('disconnecting on one device removes the tools on another at its next session', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');
    const b = await device(platform, 'B');
    await a.service.connect('amap', { apiKey: GOOD });
    const open = await amapEntry(b.service);
    if (!open) throw new Error('AMap should be handed to the session');

    expect(await a.service.disconnect('amap')).toEqual({ success: true });
    expect(await a.fixture.registry.listAccounts('amap')).toEqual([]);

    // The session that already has the tools: its next call says plainly that AMap is not connected.
    const endpoint = await endpointOf(open);
    await expect(endpoint.fetch!(endpoint.url, { ...MCP_CALL, headers: endpoint.headers })).rejects.toThrow(
      'amap is not connected in Gugu any more; reconnect it.'
    );
    // The next session on that device gets no AMap tools, and its library stops listing AMap.
    expect(await amapEntry(b.service)).toBeNull();
    expect(await b.fixture.registry.listAccounts('amap')).toEqual([]);
  });

  it('a saved credential the provider now rejects reads as “reconnect”, never as a sign-in problem', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');
    const b = await device(platform, 'B');
    await a.service.connect('amap', { apiKey: GOOD });
    const open = await amapEntry(b.service);
    if (!open) throw new Error('AMap should be handed to the session');
    platform.saved.get('amap')!.rejected = true;

    const endpoint = await endpointOf(open);
    const failure = await endpoint.fetch!(endpoint.url, { ...MCP_CALL, headers: endpoint.headers }).catch((error: unknown) => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/saved amap credential was rejected; reconnect/);
    expect((failure as Error).message).not.toMatch(/sign|log ?in|401/i);

    expect(await b.service.check('amap')).toEqual({
      connected: false,
      errorType: 'authorization_expired',
      error: expect.stringMatching(/rejected; reconnect/),
    });
    expect(await amapEntry(b.service)).toBeNull();
    // Still listed on the device, so the person can reconnect or disconnect it there.
    expect((await b.fixture.registry.listAccounts('amap')).map((row) => row.accountId)).toEqual(['default']);
  });

  it('a key left on the device by #649 is uploaded once, and deleted only after the upload succeeded', async () => {
    const platform = fakePlatform();
    const clock = { now: 1_000_000 };
    const c = await device(platform, 'C', clock);
    await c.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });
    const secretAtUpload: boolean[] = [];
    platform.state.onPut = () => secretAtUpload.push(c.fixture.secretStore.secrets.has(AMAP_SECRET_REF));

    // The upload fails: the key stays where it is, and the device does not hammer the platform.
    platform.state.putFault = { status: 502, code: 'upstream_unavailable' };
    await c.service.refresh();
    await c.service.refresh({ maxAgeMs: 0 });
    expect(c.fixture.secretStore.secrets.get(AMAP_SECRET_REF)).toBe(JSON.stringify({ apiKey: GOOD }));
    expect(platform.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
    expect(await amapEntry(c.service)).toBeNull();

    // Later it goes through: the platform has the key, the device does not.
    platform.state.putFault = null;
    clock.now += 10 * 60_000;
    await c.service.refresh({ maxAgeMs: 0 });
    expect(platform.saved.get('amap')?.apiKey).toBe(GOOD);
    expect(c.fixture.secretStore.secrets.has(AMAP_SECRET_REF)).toBe(false);
    expect(secretAtUpload).toEqual([true, true]);
    const [row] = await c.fixture.registry.listAccounts('amap');
    expect(row?.meta?.credentialSource).toBe('platform');
    expect(await amapEntry(c.service)).not.toBeNull();

    // Once: nothing is uploaded again.
    clock.now += 10 * 60_000;
    await c.service.refresh({ maxAgeMs: 0 });
    expect(platform.requests.filter((request) => request.method === 'PUT')).toHaveLength(2);
    expect(JSON.stringify(c.logs)).not.toContain(GOOD);
  });

  it('only an installation without the platform service keeps the key on this computer, and reaches AMap from here', async () => {
    const platform = fakePlatform();
    platform.state.mode = 'absent';
    const d = await device(platform, 'D');

    // The platform service is not there: the connection keeps the key on this computer (#649's way) instead.
    expect(await d.service.connect('amap', { apiKey: GOOD })).toEqual({ keepHere: true });
    expect(d.service.custody('amap')).toBe('local');
    expect(await d.fixture.registry.listAccounts('amap')).toEqual([]);

    // With the key in this computer's own store, the session builds AMap's own address here.
    local.accounts.set('amap', { apiKey: GOOD });
    const entry = await amapEntry(d.service);
    if (!entry) throw new Error('AMap should be handed to the session');
    expect((await endpointOf(entry)).url).toBe(`https://mcp.amap.com/mcp?key=${GOOD}`);
  });

  it('a platform not open to the person is not a fallback: nothing is kept on the device and nothing is used from it', async () => {
    const platform = fakePlatform();
    platform.state.mode = 'closed';
    const d = await device(platform, 'D');
    await d.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });

    const result = await d.service.connect('amap', { apiKey: BAD });
    expect(result).toMatchObject({ success: false, errorType: 'not_open' });
    expect(JSON.stringify(result)).not.toContain(BAD);
    expect(d.service.custody('amap')).toBe('platform');
    expect(await d.service.check('amap')).toMatchObject({ connected: false, errorType: 'not_open' });

    // Even a key this computer still holds from #649 is not used, and it is not deleted either.
    local.accounts.set('amap', { apiKey: GOOD });
    expect(await amapEntry(d.service)).toBeNull();
    expect(d.fixture.secretStore.secrets.get(AMAP_SECRET_REF)).toBe(JSON.stringify({ apiKey: GOOD }));
  });
});

function noLegacy() {
  const kv = { get: async () => null, del: async () => undefined };
  return {
    secrets: { getSecret: async () => null, deleteSecret: async () => undefined },
    kv: { jira: kv, gitlab: kv, forgejo: kv, plane: kv },
  };
}