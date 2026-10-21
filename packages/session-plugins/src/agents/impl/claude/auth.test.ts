import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { claudeAuthStatus } from './auth';

function ctx(overrides: Partial<AgentAuthContext> = {}): AgentAuthContext {
  return {
    cli: 'claude',
    env: {},
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    fs: {
      read: vi.fn(),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
    ...overrides,
  };
}

describe('claudeAuthStatus', () => {
  it('reports authenticated from ANTHROPIC_API_KEY without probing the CLI', async () => {
    const exec = vi.fn();

    await expect(
      claudeAuthStatus(ctx({ env: { ANTHROPIC_API_KEY: 'test-key' }, exec }))
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'api-key' });
    expect(exec).not.toHaveBeenCalled();
  });

  /**
   * 夹具一律照 `claude auth status` 的**真实**输出(#7146:旧夹具编了一个 `oauthAccount` 字段,
   * 真 CLI 从不输出它,订阅用户因此永远判不成订阅,而测试一直是绿的)。
   * 形状取自 Claude Code 2.1.296 本机实测:`authMethod` 只取
   * none / third_party / claude.ai / api_key_helper / oauth_token / api_key,
   * `subscriptionType` 只在 `claude.ai` 时写出。
   */
  function statusExec(status: Record<string, unknown>) {
    return vi.fn().mockResolvedValue({ stdout: JSON.stringify(status, null, 2), stderr: '' });
  }

  it('reads a claude.ai login as a subscription and extracts the email', async () => {
    const exec = statusExec({
      loggedIn: true,
      authMethod: 'claude.ai',
      apiProvider: 'firstParty',
      analyticsDisabled: false,
      email: 'user@example.com',
      orgId: 'org-1',
      orgName: 'Example',
      subscriptionType: 'max',
    });

    await expect(claudeAuthStatus(ctx({ exec }))).resolves.toEqual({
      kind: 'authenticated',
      account: 'user@example.com',
      credentialKind: 'subscription',
    });
    expect(exec).toHaveBeenCalledWith('claude', ['auth', 'status'], { timeout: 5000 });
  });

  it('reads a long-lived subscription token (claude setup-token) as a subscription', async () => {
    const exec = statusExec({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' });

    await expect(claudeAuthStatus(ctx({ exec }))).resolves.toEqual({
      kind: 'authenticated',
      credentialKind: 'subscription',
    });
  });

  it('reads a console-managed or helper API key as an api key', async () => {
    await expect(
      claudeAuthStatus(
        ctx({
          exec: statusExec({
            loggedIn: true,
            authMethod: 'api_key',
            apiProvider: 'firstParty',
            apiKeySource: '/login managed key',
            email: 'user@example.com',
          }),
        })
      )
    ).resolves.toEqual({ kind: 'authenticated', account: 'user@example.com', credentialKind: 'api-key' });
    await expect(
      claudeAuthStatus(
        ctx({ exec: statusExec({ loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' }) })
      )
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'api-key' });
  });

  it('claims neither when a third-party cloud pays (Bedrock / Vertex)', async () => {
    const exec = statusExec({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' });

    await expect(claudeAuthStatus(ctx({ exec }))).resolves.toEqual({ kind: 'authenticated' });
  });

  it('reports unauthenticated when claude auth status exits 1 with status JSON', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stdout: JSON.stringify({ loggedIn: false }),
      stderr: '',
      message: 'Command failed: claude auth status\n',
    });

    await expect(claudeAuthStatus(ctx({ exec }))).resolves.toEqual({ kind: 'unauthenticated' });
  });

  it('reports unknown when an older CLI does not recognize the auth status command', async () => {
    const exec = vi.fn().mockRejectedValue({
      code: 1,
      stdout: '',
      stderr: "error: unknown command 'auth'",
    });

    await expect(claudeAuthStatus(ctx({ exec }))).resolves.toEqual({ kind: 'unknown' });
  });
});
