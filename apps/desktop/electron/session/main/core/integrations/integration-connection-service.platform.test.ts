import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #921 资源库的「连接 / 断开 / 查状态」对平台保管凭据的那几家(高德)走平台:key 交给平台,❌ 进本机凭据库、
 * ❌ 本机去连高德验 key。这里只看分路 —— 平台那一侧的行为见 platform-credentials.db.test.ts。
 */

const platform = vi.hoisted(() => ({
  isPlatformProvider: (integrationId: string) => integrationId === 'amap',
  custody: vi.fn((): 'platform' | 'local' => 'platform'),
  connect: vi.fn(async (): Promise<unknown> => ({ success: true as const })),
  disconnect: vi.fn(async () => ({ success: true })),
  check: vi.fn(async () => ({
    connected: false as const,
    errorType: 'authorization_expired' as const,
    error: 'The saved amap credential was rejected; reconnect it in Gugu.',
  })),
  checkAccounts: vi.fn(async () => [{ accountId: 'default', connected: true }]),
}));
const store = vi.hoisted(() => ({
  upsertAccount: vi.fn(async () => undefined),
  getAccount: vi.fn(async (): Promise<unknown> => null),
  delete: vi.fn(async () => undefined),
  listAccounts: vi.fn(async () => []),
}));

vi.mock('./platform-credentials-instance', () => ({ platformCredentials: platform }));
vi.mock('./integration-credential-store-instance', () => ({ integrationCredentialStore: store }));

const network = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
  throw new Error('This test has no network: AMap must not be called from the device.');
});
vi.stubGlobal('fetch', network);
afterAll(() => vi.unstubAllGlobals());

const { IntegrationConnectionService } = await import('./integration-connection-service');
const CAPABILITIES = { requiresRepositoryUrl: false, supportsIssueContext: false };

beforeEach(() => {
  vi.clearAllMocks();
  platform.custody.mockReturnValue('platform');
  network.mockImplementation(async () => {
    throw new Error('This test has no network: AMap must not be called from the device.');
  });
});

const GOOD = '0123456789abcdef0123456789abcdef';

/** AMap's own MCP, as it answers a good key (only reached where the platform has no such service). */
function amapAnswers(): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (_input, init) => {
    const message = JSON.parse(String(init?.body ?? '{}')) as { id?: number; method?: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    const result =
      message.method === 'initialize'
        ? { protocolVersion: '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'amap', version: '1' } }
        : message.method === 'tools/list'
          ? { tools: [{ name: 'maps_weather', inputSchema: { type: 'object' } }] }
          : { content: [{ type: 'text', text: '{"city":"北京市"}' }] };
    return Response.json({ jsonrpc: '2.0', id: message.id, result });
  };
}

describe('integrations whose credential the platform keeps (#921)', () => {
  it('hands the key to the platform, not to the local credential store', async () => {
    const result = await new IntegrationConnectionService().connect('amap', { apiKey: 'k-1' });

    expect(result).toEqual({ success: true });
    expect(platform.connect).toHaveBeenCalledWith('amap', { apiKey: 'k-1' }, { editing: false });
    expect(store.upsertAccount).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('disconnects on the platform, which disconnects every device', async () => {
    expect(await new IntegrationConnectionService().disconnect('amap')).toEqual({ success: true });
    expect(platform.disconnect).toHaveBeenCalledWith('amap');
    expect(store.delete).not.toHaveBeenCalled();
  });

  it('asks the platform whether it is connected, and reports a rejected credential as needing a reconnect', async () => {
    expect(await new IntegrationConnectionService().checkConnection('amap', CAPABILITIES)).toEqual({
      connected: false,
      errorType: 'authorization_expired',
      error: 'The saved amap credential was rejected; reconnect it in Gugu.',
      capabilities: CAPABILITIES,
    });
    expect(await new IntegrationConnectionService().checkAccounts('amap')).toEqual([{ accountId: 'default', connected: true }]);
    expect(network).not.toHaveBeenCalled();
  });

  it('keeps the key on this computer only when the platform has no such service', async () => {
    platform.connect.mockResolvedValueOnce({ keepHere: true });
    network.mockImplementation(amapAnswers());

    expect(await new IntegrationConnectionService().connect('amap', { apiKey: GOOD })).toMatchObject({ success: true });
    expect(store.upsertAccount).toHaveBeenCalledWith('amap', { accountId: 'default', credentials: { apiKey: GOOD } });
  });

  it('keeps nothing on the device when the platform reports a configuration failure', async () => {
    platform.connect.mockResolvedValueOnce({ success: false, errorType: 'service_unavailable', error: 'Credential service encryption key is not configured.' });

    expect(await new IntegrationConnectionService().connect('amap', { apiKey: GOOD })).toMatchObject({ success: false, errorType: 'service_unavailable' });
    expect(store.upsertAccount).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  it('where the platform has no such service, disconnecting and checking stay on this computer', async () => {
    platform.custody.mockReturnValue('local');
    expect(await new IntegrationConnectionService().disconnect('amap')).toEqual({ success: true });
    expect(store.delete).toHaveBeenCalledWith('amap');
    expect(platform.disconnect).not.toHaveBeenCalled();
    expect(platform.check).not.toHaveBeenCalled();
  });

  it('checks the key on this computer when the first ask finds no platform service here', async () => {
    // Before the ask custody still reads as platform; the ask itself finds the service missing.
    platform.custody.mockReturnValueOnce('platform').mockReturnValue('local');
    platform.check.mockResolvedValueOnce({ connected: false } as never);
    store.getAccount.mockResolvedValue({ accountId: 'default', credentials: { apiKey: GOOD } });
    network.mockImplementation(amapAnswers());

    expect(await new IntegrationConnectionService().checkConnection('amap', CAPABILITIES)).toMatchObject({ connected: true });
  });
});
