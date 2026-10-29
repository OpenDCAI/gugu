import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { integrationPluginRegistry } from '@gugu/session-plugins/integrations';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installedCliTool } from './cli/cli-tool-installer';

const store = vi.hoisted(() => ({
  accounts: new Map<string, unknown>(),
}));

// #921 平台保管凭据那一侧不在本文件的范围:替成「没有平台保管的那几家」,❌ 牵进真的账号表与钥匙串。
vi.mock('./platform-credentials-instance', () => ({
  platformCredentials: { isPlatformProvider: () => false, custody: () => null },
}));
vi.mock('./integration-credential-store-instance', () => ({
  integrationCredentialStore: {
    isConfigured: async (integrationId: string) => store.accounts.has(integrationId),
    getAccount: async (integrationId: string) => store.accounts.get(integrationId) ?? null,
    upsertAccount: async () => undefined,
  },
}));

// The issue systems answer through their issue providers; only Notion is faked
// here so the test can tell which path each integration took.
const notionStatus = { connected: true, displayName: 'from the issue provider', capabilities: { requiresRepositoryUrl: false, supportsIssueContext: true } };
vi.mock('@main/core/issues/registry', () => ({
  getIssueProvider: (type: string) =>
    type === 'notion'
      ? {
          capabilities: notionStatus.capabilities,
          checkConnection: async () => notionStatus,
          isConfigured: async () => true,
        }
      : undefined,
}));

const { checkAllIntegrationConnections, checkConfiguredIntegrations } = await import('./connection-statuses');

/** A browser authorization that has run out and carries no refresh token — what Dida365 issues. */
function expiredWithoutRefresh(serverUrl: string) {
  return {
    accountId: 'default',
    credentials: {
      serverUrl,
      redirectUrl: 'http://127.0.0.1:53682/callback',
      clientInformation: { client_id: 'client-1' },
      tokens: { access_token: 'access-1', token_type: 'bearer', expires_in: 60 },
      obtainedAt: 0,
    },
  };
}

beforeEach(() => store.accounts.clear());

describe('资源库那一页的「连没连上」(#7210)', () => {
  it('覆盖注册表里的每一家,不只是 issue 系统', async () => {
    const ids = integrationPluginRegistry.getAll().map((plugin) => plugin.metadata.id);
    expect(ids).toEqual(expect.arrayContaining(['feishu', 'tencent-docs', 'dida', 'notion']));

    const configured = await checkConfiguredIntegrations();

    expect(Object.keys(configured).sort()).toEqual([...ids].sort());
  });

  it('不是 issue 系统的集成按它存没存凭据回答;issue 系统照旧问它的 issue provider', async () => {
    store.accounts.set('feishu', { accountId: 'default', credentials: {} });

    const configured = await checkConfiguredIntegrations();

    expect(configured.feishu).toBe(true);
    expect(configured['tencent-docs']).toBe(false);
    expect(configured.notion).toBe(true);
  });

  it('没连的那一家:没连上,也不带错误', async () => {
    const statuses = await checkAllIntegrationConnections();

    expect(statuses.dida).toEqual({
      connected: false,
      capabilities: { requiresRepositoryUrl: false, supportsIssueContext: false },
    });
    expect(statuses.notion).toBe(notionStatus);
  });

  it('授权到期又没有续期令牌(滴答清单):如实说授权已失效,❌ 当成还连着', async () => {
    store.accounts.set('dida', expiredWithoutRefresh('https://mcp.dida365.com'));

    const statuses = await checkAllIntegrationConnections();

    expect(statuses.dida).toMatchObject({ connected: false, errorType: 'authorization_expired' });
  });
});

describe('官方命令行那几家(钉钉 dws):连没连上问工具自己(#7210)', () => {
  let guguHome: string;
  const previousHome = process.env.GUGU_HOME;
  const connectedRecord = { accountId: 'default', credentials: { tool: 'dws', connectedAt: 1 } };

  beforeEach(() => {
    guguHome = mkdtempSync(path.join(tmpdir(), 'gugu-cli-status-'));
    process.env.GUGU_HOME = guguHome;
  });

  afterEach(() => {
    if (previousHome === undefined) delete process.env.GUGU_HOME;
    else process.env.GUGU_HOME = previousHome;
    rmSync(guguHome, { recursive: true, force: true });
  });

  /** 在咕咕的目录里放一个「装好了」的假 dws,`auth status` 时按给的答。 */
  function installFakeDws(authenticated: boolean) {
    const installed = installedCliTool('dws');
    mkdirSync(path.dirname(installed.binPath), { recursive: true });
    writeFileSync(installed.binPath, `#!/bin/sh\necho '{"success":true,"authenticated":${authenticated}}'\n`);
    chmodSync(installed.binPath, 0o755);
    writeFileSync(path.join(path.dirname(installed.binPath), '..', '.complete'), 'test\n');
  }

  it('记录在、工具说登着 → 已连接', async () => {
    store.accounts.set('dingtalk', connectedRecord);
    installFakeDws(true);
    expect((await checkAllIntegrationConnections()).dingtalk).toMatchObject({ connected: true });
  });

  it('记录在、工具说没登(对方撤了授权 / 过期)→ 授权已失效,❌ 当成还连着', async () => {
    store.accounts.set('dingtalk', connectedRecord);
    installFakeDws(false);
    expect((await checkAllIntegrationConnections()).dingtalk).toMatchObject({
      connected: false,
      errorType: 'authorization_expired',
    });
  });

  it('记录在、工具却不在了 → 同样要重新连接', async () => {
    store.accounts.set('dingtalk', connectedRecord);
    expect((await checkAllIntegrationConnections()).dingtalk).toMatchObject({
      connected: false,
      errorType: 'authorization_expired',
    });
  });
});
