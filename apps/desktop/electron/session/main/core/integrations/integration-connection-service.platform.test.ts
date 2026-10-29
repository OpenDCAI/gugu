import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * #921 资源库的「连接 / 断开 / 查状态」对平台保管凭据的那几家(高德)走平台:key 交给平台,❌ 进本机凭据库、
 * ❌ 本机去连高德验 key。这里只看分路 —— 平台那一侧的行为见 platform-credentials.db.test.ts。
 */

const platform = vi.hoisted(() => ({
  isPlatformProvider: (integrationId: string) => integrationId === 'amap',
  connect: vi.fn(async () => ({ success: true as const })),
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
  getAccount: vi.fn(async () => null),
  delete: vi.fn(async () => undefined),
  listAccounts: vi.fn(async () => []),
}));

vi.mock('./platform-credentials-instance', () => ({ platformCredentials: platform }));
vi.mock('./integration-credential-store-instance', () => ({ integrationCredentialStore: store }));

const network = vi.fn(async () => {
  throw new Error('This test has no network: AMap must not be called from the device.');
});
vi.stubGlobal('fetch', network);
afterAll(() => vi.unstubAllGlobals());

const { IntegrationConnectionService } = await import('./integration-connection-service');
const CAPABILITIES = { requiresRepositoryUrl: false, supportsIssueContext: false };

beforeEach(() => vi.clearAllMocks());

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
});
