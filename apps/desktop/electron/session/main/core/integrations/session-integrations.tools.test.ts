import { describe, expect, it, vi } from 'vitest';

/**
 * #921 × #926 一家凭据由平台保管的集成,会话里给的是平台转发口的 MCP 工具:助理索引 ❌ 把它说成「只用来关联 issue」。
 * 不靠它碰巧带着本机退路的地址(`mcp`)—— 以后的服务商(滴滴、瑞幸…)可能没有那一条。
 */

vi.mock('@gugu/session-plugins/integrations', async (importActual) => {
  const actual = await importActual<typeof import('@gugu/session-plugins/integrations')>();
  const amapWithoutFallback = {
    metadata: { id: 'amap', name: '高德地图' },
    capabilities: { auth: { methods: [{ kind: 'form', custody: 'platform', fields: [{ id: 'apiKey', secret: true, required: true }] }] } },
  };
  const github = { metadata: { id: 'github', name: 'GitHub' }, capabilities: { auth: { methods: [{ kind: 'oauth-device', clientId: 'x', scopes: [] }] } } };
  const plugins = [amapWithoutFallback, github];
  return {
    ...actual,
    integrationPluginRegistry: { getAll: () => plugins, get: (id: string) => plugins.find((plugin) => plugin.metadata.id === id) },
  };
});
vi.mock('./platform-credentials-instance', () => ({
  platformCredentials: { isPlatformProvider: (id: string) => id === 'amap', custody: (id: string) => (id === 'amap' ? 'platform' : null) },
}));
vi.mock('./integration-credential-store-instance', () => ({ integrationCredentialStore: { isConfigured: async () => false } }));
vi.mock('./integration-connection-service', () => ({ integrationConnectionService: { getFreshAccount: async () => null } }));

const { integrationGivesSessionTools } = await import('./session-integrations');

describe('integrations that hand sessions tools (#921, #926)', () => {
  it('counts a provider whose credential the platform keeps, so AMap is never labeled issue-only', () => {
    expect(integrationGivesSessionTools('amap')).toBe(true);
    expect(integrationGivesSessionTools('github')).toBe(false);
  });
});
