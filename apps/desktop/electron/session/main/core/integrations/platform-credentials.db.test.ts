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
  /** When the person last disconnected each provider (an explicit connect clears it). */
  const disconnected = new Map<string, string>();
  let disconnections = 0;
  const requests: Array<{ method: string; path: string; authorization: string | null; body: unknown; raw: string }> = [];
  const state = {
    /** The next PUTs answer this; `code: null` = an answer without the platform's error code (a proxy, say). */
    putFault: null as null | { status: number; code: string | null },
    /** PUTs never reach the platform (the network drops them); everything else answers. */
    putDown: false,
    /** false = `GET /integrations` does not list AMap at all. */
    listsAmap: true,
    onPut: null as null | (() => void),
    /** absent = this installation has no such service (the gateway's 404); closed = not open to this person (503). */
    mode: 'open' as 'open' | 'absent' | 'closed',
    /** The network is down: every request fails before it reaches the platform. */
    down: false,
    /** Holds the next `GET /integrations` until released. */
    holdGet: null as null | Promise<void>,
  };
  /** The person disconnects on some device (what `DELETE …/credential` does on the platform). */
  const disconnect = (provider: string) => {
    saved.delete(provider);
    disconnected.set(provider, new Date(Date.UTC(2026, 9, 29, 3, 0, disconnections++)).toISOString());
  };
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const method = init?.method ?? 'GET';
    const raw = typeof init?.body === 'string' ? init.body : '';
    const path = url.pathname.replace('/functions/v1/cloud-computer', '');
    requests.push({ method, path, authorization: new Headers(init?.headers).get('authorization'), body: raw ? JSON.parse(raw) : undefined, raw: `${url}${raw}` });
    if (state.down) throw new TypeError('fetch failed');
    if (state.mode === 'absent') return Response.json({ code: 'NOT_FOUND', message: 'Requested function was not found' }, { status: 404 });
    if (state.mode === 'closed') return Response.json({ error: 'not_open', message: 'Not open to you yet.' }, { status: 503 });
    if (path === '/integrations' && method === 'GET') {
      if (state.holdGet) await state.holdGet;
      const amap = saved.get('amap');
      return Response.json({
        providers: state.listsAmap ? [{
          provider: 'amap',
          // Every provider in the table is listed: `not_connected` with no times = nothing stored.
          accounts: [{
            ...(amap
              ? { accountId: 'default', connected: !amap.rejected, state: amap.rejected ? 'reconnect' : 'connected', updatedAt: '2026-10-29T02:00:00.000Z', checkedAt: '2026-10-29T02:00:01.000Z' }
              : { accountId: 'default', connected: false, state: 'not_connected', updatedAt: null, checkedAt: null }),
            disconnectedAt: disconnected.get('amap') ?? null,
          }],
        }] : [],
      });
    }
    const credential = /^\/integrations\/([^/]+)\/credential$/.exec(path);
    if (credential && method === 'PUT') {
      state.onPut?.();
      if (state.putDown) throw new TypeError('fetch failed');
      if (state.putFault) {
        const { status, code } = state.putFault;
        return Response.json(code ? { error: code, message: 'Try again later.' } : { message: 'Bad gateway or proxy answer.' }, { status });
      }
      const put = JSON.parse(raw) as { fields?: { apiKey?: string }; migration?: { savedAt: string | null }; connect?: unknown };
      if ((put.connect !== undefined && put.migration) || (put.connect !== undefined && put.connect !== 'manual')) {
        return Response.json({ error: 'invalid_fields', message: 'connect is "manual", alone.' }, { status: 400 });
      }
      const manual = put.connect === 'manual';
      // No marker = a migration with an unknown save time: it can only create.
      const migration = manual ? null : (put.migration ?? { savedAt: null });
      if (migration) {
        // A key moved up from a device never overwrites what the platform keeps, and never undoes a disconnection.
        if (saved.has(credential[1]!)) return Response.json({ error: 'already_connected', message: 'Already connected.' }, { status: 409 });
        const at = disconnected.get(credential[1]!);
        if (at && (migration.savedAt === null || at > migration.savedAt)) {
          return Response.json({ error: 'disconnected_after', message: 'Disconnected after this key was saved.' }, { status: 409 });
        }
      }
      const apiKey = put.fields?.apiKey;
      // A careless upstream message that repeats the key: the client must not pass it on.
      if (apiKey !== GOOD) return Response.json({ error: 'auth_failed', message: `AMap rejected ${apiKey} (INVALID_USER_KEY)` }, { status: 422 });
      saved.set(credential[1]!, { apiKey, rejected: false });
      if (manual) disconnected.delete(credential[1]!);
      return Response.json({ connected: true, updatedAt: '2026-10-29T02:00:00.000Z', checkedAt: '2026-10-29T02:00:01.000Z' });
    }
    if (credential && method === 'DELETE') {
      disconnect(credential[1]!);
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
  return { saved, disconnected, disconnect, requests, state, fetchImpl };
}

type Platform = ReturnType<typeof fakePlatform>;
const opened: RegistryFixture[] = [];
afterEach(() => {
  for (const fixture of opened.splice(0)) fixture.close();
  local.accounts.clear();
});

/** One of the person's devices: its own account table, signed in with its own session token. */
async function device(platform: Platform, name: string, clock = { now: 1_000_000 }, options: { noPlatform?: boolean } = {}) {
  const fixture = await openRegistryFixture('empty');
  opened.push(fixture);
  const token = { value: `${name}-session-1` };
  const logs: unknown[] = [];
  const service = new PlatformCredentialService({
    client: () => options.noPlatform
      ? null
      : createPlatformIntegrationsClient({ baseUrl: BASE, accessToken: async () => token.value, anonKey: 'anon', fetch: platform.fetchImpl }),
    accounts: fixture.registry,
    providers: platformCustodyProviders,
    log: { info: (...args: unknown[]) => logs.push(args), warn: (...args: unknown[]) => logs.push(args) },
    now: () => clock.now,
  });
  return { fixture, service, token, logs };
}

/** The device's background look at the platform (app start, sign-in change, the library or panel opening). */
async function lookedInTheBackground(d: { service: InstanceType<typeof PlatformCredentialService> }) {
  expect(await d.service.refresh({ maxAgeMs: 0 })).toBe(true);
}

/** What a session that starts now on this device is handed for AMap. */
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
    expect(put).toMatchObject({ path: '/integrations/amap/credential', authorization: 'Bearer A-session-1' });
    expect(put?.body).toEqual({ fields: { apiKey: GOOD }, connect: 'manual' });
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
    await lookedInTheBackground(b);

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
    await lookedInTheBackground(b);
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

  it('disconnecting on one device removes the tools on another from its next look at the platform', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');
    const b = await device(platform, 'B');
    await a.service.connect('amap', { apiKey: GOOD });
    await lookedInTheBackground(b);
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
    await lookedInTheBackground(b);
    expect(await amapEntry(b.service)).toBeNull();
    expect(await b.fixture.registry.listAccounts('amap')).toEqual([]);
  });

  it('a saved credential the provider now rejects reads as “reconnect”, never as a sign-in problem', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');
    const b = await device(platform, 'B');
    await a.service.connect('amap', { apiKey: GOOD });
    await lookedInTheBackground(b);
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
    expect(b.service.needsReconnect('amap', (await b.fixture.registry.listAccounts('amap'))[0]!)).toBe(true);
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
    // #649 never recorded when the key was saved: it goes up as a migration with no save time.
    expect(platform.requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([
      { fields: { apiKey: GOOD }, migration: { savedAt: null } },
      { fields: { apiKey: GOOD }, migration: { savedAt: null } },
    ]);
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

  it('a provider the platform lists as not_connected leaves no row on the device and gives no tools', async () => {
    const platform = fakePlatform();
    const d = await device(platform, 'D');

    expect(await d.service.refresh({ maxAgeMs: 0 })).toBe(true);
    expect(await d.fixture.registry.listAccounts('amap')).toEqual([]);
    expect(await amapEntry(d.service)).toBeNull();
    expect(await d.service.check('amap')).toEqual({ connected: false });
  });

  it.each([
    ['timed out', 408, 'request_timeout', 'timed_out'],
    ['rate-limited', 429, 'rate_limited', 'rate_limited'],
    ['found AMap not available (502)', 502, 'upstream_unavailable', 'provider_unavailable'],
  ] as const)('a connection the platform %s reads as temporary and keeps nothing', async (_case, status, code, errorType) => {
    const platform = fakePlatform();
    const d = await device(platform, 'D');
    platform.state.putFault = { status, code };

    const result = await d.service.connect('amap', { apiKey: GOOD });
    expect(result).toMatchObject({ success: false, errorType });
    expect(JSON.stringify(result)).not.toContain(GOOD);
    expect(await d.fixture.registry.listAccounts('amap')).toEqual([]);
    expect(d.fixture.secretStore.secrets.size).toBe(0);
  });

  it('with no platform configured at all, the key is kept on this computer from the first look, edits included', async () => {
    const platform = fakePlatform();
    const d = await device(platform, 'D', undefined, { noPlatform: true });

    expect(d.service.custody('amap')).toBe('local');
    // Editing with the secret left blank goes the local way, which keeps the saved secret.
    expect(await d.service.connect('amap', { apiKey: '' }, { editing: true })).toEqual({ keepHere: true });
    expect(platform.requests).toEqual([]);
  });

  it('when the platform service goes away, what it had mirrored on this device goes too', async () => {
    const platform = fakePlatform();
    const d = await device(platform, 'D');
    await d.service.connect('amap', { apiKey: GOOD });
    expect(await d.fixture.registry.listAccounts('amap')).toHaveLength(1);

    platform.state.mode = 'absent';
    await d.service.refresh({ maxAgeMs: 0 });
    expect(d.service.custody('amap')).toBe('local');
    expect(await d.fixture.registry.listAccounts('amap')).toEqual([]);
  });

  it('a #649 key can still be removed while the platform is not open to the person', async () => {
    const platform = fakePlatform();
    platform.state.mode = 'closed';
    const d = await device(platform, 'D');
    await d.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });

    expect(await d.service.disconnect('amap')).toEqual({ success: true });
    expect(await d.fixture.registry.listAccounts('amap')).toEqual([]);
    expect(d.fixture.secretStore.secrets.size).toBe(0);
  });

  it('a session starts on what the device already knows: it never waits for the platform', async () => {
    const platform = fakePlatform();
    const a = await device(platform, 'A');
    await a.service.connect('amap', { apiKey: GOOD });
    const never = await device(platform, 'N');
    let release!: () => void;
    platform.state.holdGet = new Promise<void>((resolve) => (release = resolve));
    const waited = (ms: number) => new Promise<'waited'>((resolve) => setTimeout(() => resolve('waited'), ms));

    try {
      // Connected here: the tools come from the platform's answer this device already mirrors.
      expect(await Promise.race([amapEntry(a.service).then((entry) => entry?.integrationId ?? null), waited(1_000)])).toBe('amap');
      // Never used AMap: nothing to wait for either.
      expect(await Promise.race([amapEntry(never.service), waited(1_000)])).toBeNull();
    } finally {
      platform.state.holdGet = null;
      release();
    }
  });

  it('a failed ask is not repeated by every look for a while; a forced look still asks again', async () => {
    const platform = fakePlatform();
    const clock = { now: 1_000_000 };
    const d = await device(platform, 'D', clock);
    platform.state.down = true;
    const asks = () => platform.requests.filter((request) => request.method === 'GET').length;

    expect(await d.service.refresh()).toBe(false);
    expect(await d.service.refresh()).toBe(false);
    expect(asks()).toBe(1);
    await d.service.refresh({ maxAgeMs: 0 });
    expect(asks()).toBe(2);
    clock.now += 60_000;
    await d.service.refresh();
    expect(asks()).toBe(3);
  });

  it('after a sign-in change, a read does not take the answer of an ask made under the previous sign-in', async () => {
    const platform = fakePlatform();
    const d = await device(platform, 'D');
    let release!: () => void;
    platform.state.holdGet = new Promise<void>((resolve) => (release = resolve));

    const before = d.service.refresh({ maxAgeMs: 0 });
    // The first ask is on the wire (under the first sign-in) before the sign-in changes.
    while (!platform.requests.some((request) => request.method === 'GET')) await new Promise((resolve) => setTimeout(resolve, 1));
    d.token.value = 'D-session-2';
    d.service.invalidate();
    const after = d.service.refresh({ maxAgeMs: 0 });
    platform.state.holdGet = null;
    release();
    await Promise.all([before, after]);

    expect(platform.requests.filter((request) => request.method === 'GET').map((request) => request.authorization)).toEqual([
      'Bearer D-session-1',
      'Bearer D-session-2',
    ]);
  });

  it('never rejects: a provider list that cannot be read is a failed ask, not a crash of whoever asked', async () => {
    const fixture = await openRegistryFixture('empty');
    opened.push(fixture);
    const service = new PlatformCredentialService({
      client: () => null,
      accounts: fixture.registry,
      providers: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'auth')");
      },
      log: { info: () => undefined, warn: () => undefined },
    });
    await expect(service.refresh({ maxAgeMs: 0 })).resolves.toBe(false);
  });

  it('moves only the account #649 saved (the default one); any other local row is left as it is', async () => {
    const platform = fakePlatform();
    const d = await device(platform, 'D');
    await d.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'other', secret: JSON.stringify({ apiKey: BAD }) });
    await d.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });

    await d.service.refresh({ maxAgeMs: 0 });
    expect(platform.requests.filter((request) => request.method === 'PUT').map((request) => request.body)).toEqual([{ fields: { apiKey: GOOD }, migration: { savedAt: null } }]);
    expect(d.fixture.secretStore.secrets.has('provider-credential:amap:other')).toBe(true);
  });
  describe('a #649 key never undoes a disconnection', () => {
    const puts = (platform: Platform, token: string) =>
      platform.requests.filter((request) => request.method === 'PUT' && request.authorization === `Bearer ${token}`);

    it('A disconnects; an offline device that comes back holding a #649 key does not bring AMap back', async () => {
      const platform = fakePlatform();
      const a = await device(platform, 'A');
      const b = await device(platform, 'B');
      // B was offline all along, holding the key #649 saved there.
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });
      expect(await a.service.connect('amap', { apiKey: GOOD })).toEqual({ success: true });
      expect(await a.service.disconnect('amap')).toEqual({ success: true });

      // B comes back online.
      await b.service.refresh({ maxAgeMs: 0 });
      expect(puts(platform, 'B-session-1')).toEqual([]);
      expect(platform.saved.has('amap')).toBe(false);
      expect(b.fixture.secretStore.secrets.size).toBe(0);
      expect(await b.fixture.registry.listAccounts('amap')).toEqual([]);
      expect(await amapEntry(b.service)).toBeNull();
      expect(await amapEntry(a.service)).toBeNull();
    });

    it('a disconnection that lands between the look and the upload: the platform turns it down, the local copy goes, no retry', async () => {
      const platform = fakePlatform();
      const clock = { now: 1_000_000 };
      const b = await device(platform, 'B', clock);
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });
      platform.state.onPut = () => platform.disconnect('amap');

      await b.service.refresh({ maxAgeMs: 0 });
      expect(puts(platform, 'B-session-1').map((request) => request.body)).toEqual([{ fields: { apiKey: GOOD }, migration: { savedAt: null } }]);
      expect(platform.saved.has('amap')).toBe(false);
      expect(b.fixture.secretStore.secrets.size).toBe(0);
      expect(await b.fixture.registry.listAccounts('amap')).toEqual([]);
      expect(await amapEntry(b.service)).toBeNull();

      platform.state.onPut = null;
      clock.now += 10 * 60_000;
      await b.service.refresh({ maxAgeMs: 0 });
      expect(puts(platform, 'B-session-1')).toHaveLength(1);
    });

    it('A stores a newer key between B’s look and B’s upload: the newer key survives, B’s copy goes, AMap reads as connected through the platform', async () => {
      const platform = fakePlatform();
      const clock = { now: 1_000_000 };
      const b = await device(platform, 'B', clock);
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });
      // A connects its newer key after B's look and before B's upload reaches the platform.
      platform.state.onPut = () => {
        if (!platform.saved.has('amap')) platform.saved.set('amap', { apiKey: 'a-newer-key-from-A', rejected: false });
      };

      await b.service.refresh({ maxAgeMs: 0 });
      expect(platform.saved.get('amap')?.apiKey).toBe('a-newer-key-from-A');
      expect(b.fixture.secretStore.secrets.size).toBe(0);
      const [row] = await b.fixture.registry.listAccounts('amap');
      expect(row?.meta?.credentialSource).toBe('platform');
      expect(await amapEntry(b.service)).not.toBeNull();

      clock.now += 10 * 60_000;
      await b.service.refresh({ maxAgeMs: 0 });
      expect(puts(platform, 'B-session-1')).toHaveLength(1);
    });

    it.each([
      ['rejects the old key (422)', BAD, null],
      ['finds the old key malformed (400)', GOOD, { status: 400, code: 'invalid_fields' }],
    ] as const)('the provider %s on the way up: the local copy goes, no retry, and the connection page asks for a new key', async (_case, key, fault) => {
      const platform = fakePlatform();
      const clock = { now: 1_000_000 };
      const b = await device(platform, 'B', clock);
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: key }) });
      platform.state.putFault = fault;

      await b.service.refresh({ maxAgeMs: 0 });
      expect(b.fixture.secretStore.secrets.size).toBe(0);
      const rejected = { connected: false, errorType: 'key_rejected', error: '高德地图 rejected this key; enter it again.' };
      expect(await b.service.check('amap')).toEqual(rejected);
      expect(await b.service.checkAccounts('amap')).toEqual([{ accountId: 'default', ...rejected }]);
      expect(await amapEntry(b.service)).toBeNull();
      // The assistant's index hears the same: needs a reconnect, not usable now.
      const [row] = await b.fixture.registry.listAccounts('amap');
      expect(b.service.needsReconnect('amap', row!)).toBe(true);
      for (let round = 0; round < 4; round += 1) {
        clock.now += 10 * 60_000;
        await b.service.refresh({ maxAgeMs: 0 });
      }
      expect(puts(platform, 'B-session-1')).toHaveLength(1);
      expect(JSON.stringify(b.logs)).not.toContain(key);

      // Entering a key again connects as usual.
      platform.state.putFault = null;
      expect(await b.service.connect('amap', { apiKey: GOOD })).toEqual({ success: true });
      expect(await b.service.check('amap')).toEqual({ connected: true });
    });

    it.each([
      ['the network dropping the upload', 'down'],
      ['401', { status: 401, code: 'unauthorized' }],
      ['403', { status: 403, code: 'forbidden' }],
      ['the platform’s own 404', { status: 404, code: 'unknown_provider' }],
      ['408', { status: 408, code: 'request_timeout' }],
      ['429', { status: 429, code: 'rate_limited' }],
      ['502', { status: 502, code: 'upstream_unavailable' }],
      ['503', { status: 503, code: 'upstream_unavailable' }],
      ['a 400 without the platform’s code (a proxy)', { status: 400, code: null }],
      ['a 400 with another code', { status: 400, code: 'invalid_request' }],
      ['a 422 without the platform’s code', { status: 422, code: null }],
    ] as const)('%s on the way up keeps the key on the device and backs off', async (_case, fault) => {
      const platform = fakePlatform();
      const clock = { now: 1_000_000 };
      const b = await device(platform, 'B', clock);
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });
      if (fault === 'down') platform.state.putDown = true;
      else platform.state.putFault = fault;

      await b.service.refresh({ maxAgeMs: 0 });
      expect(platform.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
      expect(b.fixture.secretStore.secrets.get(AMAP_SECRET_REF)).toBe(JSON.stringify({ apiKey: GOOD }));
      // Never "needs a reconnect": the key is fine as far as anyone knows.
      const status = await b.service.check('amap');
      expect(status.connected).toBe(false);
      expect(['key_rejected', 'authorization_expired', 'auth_failed']).not.toContain('errorType' in status ? status.errorType : undefined);
      expect(b.service.needsReconnect('amap', (await b.fixture.registry.listAccounts('amap'))[0]!)).toBe(false);
      // Backing off: not again a minute later; again once the back-off is over.
      clock.now += 60_000;
      await b.service.refresh({ maxAgeMs: 0 });
      expect(platform.requests.filter((request) => request.method === 'PUT')).toHaveLength(1);
      clock.now += 5 * 60_000;
      await b.service.refresh({ maxAgeMs: 0 });
      expect(platform.requests.filter((request) => request.method === 'PUT')).toHaveLength(2);
      expect(b.fixture.secretStore.secrets.get(AMAP_SECRET_REF)).toBe(JSON.stringify({ apiKey: GOOD }));
    });

    it('a #649 key held while AMap is not available (502) reads as “not available right now”, not as a reconnect', async () => {
      const platform = fakePlatform();
      const b = await device(platform, 'B');
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });
      platform.state.putFault = { status: 502, code: 'upstream_unavailable' };

      await b.service.refresh({ maxAgeMs: 0 });
      const unavailable = { connected: false, errorType: 'provider_unavailable', error: "高德地图 isn't available right now; try again later." };
      expect(await b.service.check('amap')).toEqual(unavailable);
      expect(await b.service.checkAccounts('amap')).toEqual([{ accountId: 'default', ...unavailable }]);
      expect(b.fixture.secretStore.secrets.get(AMAP_SECRET_REF)).toBe(JSON.stringify({ apiKey: GOOD }));
    });

    it('the back-off doubles from 5 minutes and stops growing at an hour', async () => {
      const platform = fakePlatform();
      const clock = { now: 1_000_000 };
      const b = await device(platform, 'B', clock);
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });
      platform.state.putFault = { status: 502, code: 'upstream_unavailable' };
      const started = clock.now;
      const uploadedAt: number[] = [];
      platform.state.onPut = () => uploadedAt.push((clock.now - started) / 60_000);

      for (let minute = 0; minute <= 240; minute += 5) {
        clock.now = started + minute * 60_000;
        await b.service.refresh({ maxAgeMs: 0 });
      }
      expect(uploadedAt.slice(1).map((at, index) => at - uploadedAt[index]!)).toEqual([5, 10, 20, 40, 60, 60]);
    });

    it('a provider the platform does not list is not sent up: the key stays, and goes up once it is listed and the back-off is over', async () => {
      const platform = fakePlatform();
      platform.state.listsAmap = false;
      const clock = { now: 1_000_000 };
      const b = await device(platform, 'B', clock);
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });

      await b.service.refresh({ maxAgeMs: 0 });
      expect(platform.requests.filter((request) => request.method === 'PUT')).toEqual([]);
      expect(b.fixture.secretStore.secrets.get(AMAP_SECRET_REF)).toBe(JSON.stringify({ apiKey: GOOD }));

      platform.state.listsAmap = true;
      clock.now += 60_000;
      await b.service.refresh({ maxAgeMs: 0 });
      expect(platform.requests.filter((request) => request.method === 'PUT')).toEqual([]);
      clock.now += 5 * 60_000;
      await b.service.refresh({ maxAgeMs: 0 });
      expect(platform.saved.get('amap')?.apiKey).toBe(GOOD);
      expect(b.fixture.secretStore.secrets.has(AMAP_SECRET_REF)).toBe(false);
    });

    it('a credential the platform keeps that needs a reconnect is not overwritten by a #649 key either', async () => {
      const platform = fakePlatform();
      platform.saved.set('amap', { apiKey: 'kept-on-the-platform', rejected: true });
      const b = await device(platform, 'B');
      await b.fixture.registry.upsertAccount({ providerId: 'amap', accountId: 'default', secret: JSON.stringify({ apiKey: GOOD }) });

      await b.service.refresh({ maxAgeMs: 0 });
      expect(puts(platform, 'B-session-1')).toEqual([]);
      expect(platform.saved.get('amap')?.apiKey).toBe('kept-on-the-platform');
      expect(b.fixture.secretStore.secrets.size).toBe(0);
      expect(await b.service.check('amap')).toMatchObject({ connected: false, errorType: 'authorization_expired' });
    });

    it('the connection page replaces a kept key that needs a reconnect: only its manual PUT overwrites', async () => {
      const platform = fakePlatform();
      platform.saved.set('amap', { apiKey: 'kept-on-the-platform', rejected: true });
      const b = await device(platform, 'B');

      expect(await b.service.connect('amap', { apiKey: GOOD })).toEqual({ success: true });
      expect(platform.saved.get('amap')).toEqual({ apiKey: GOOD, rejected: false });
      expect(await b.service.check('amap')).toEqual({ connected: true });
    });

    it('the connection page connects after a disconnect: its PUT is manual, and it clears the disconnection', async () => {
      const platform = fakePlatform();
      const a = await device(platform, 'A');
      const b = await device(platform, 'B');
      await a.service.connect('amap', { apiKey: GOOD });
      await a.service.disconnect('amap');
      expect(platform.disconnected.has('amap')).toBe(true);

      expect(await b.service.connect('amap', { apiKey: GOOD })).toEqual({ success: true });
      expect(puts(platform, 'B-session-1').map((request) => request.body)).toEqual([{ fields: { apiKey: GOOD }, connect: 'manual' }]);
      expect(platform.disconnected.has('amap')).toBe(false);
      await lookedInTheBackground(a);
      expect(await amapEntry(a.service)).not.toBeNull();
    });
  });
});

function noLegacy() {
  const kv = { get: async () => null, del: async () => undefined };
  return {
    secrets: { getSecret: async () => null, deleteSecret: async () => undefined },
    kv: { jira: kv, gitlab: kv, forgejo: kv, plane: kv },
  };
}
