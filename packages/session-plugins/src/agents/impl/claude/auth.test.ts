import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { claudeAuthStatus } from './auth';

function ctx(overrides: Partial<AgentAuthContext> = {}): AgentAuthContext {
  return {
    cli: 'claude',
    env: {},
    exec: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
    // `read` 必须真答一个 promise:这一格现在会被读到(settings.json 的 env 块,见 #1163),
    // 而 `PluginFs.read` 的契约就是 `Promise<string | null>`。「没有那个文件」由 null 表示。
    fs: {
      read: vi.fn(async () => null),
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

  /**
   * #1163 一份中转写在 Claude Code **自己那份** `settings.json` 里的令牌 —— cc-switch 的形状:
   * `env.ANTHROPIC_AUTH_TOKEN` + `env.ANTHROPIC_BASE_URL`。它压得住进程环境,所以 `ctx.env` 里
   * 什么都没有,而 CLI 照 `ANTHROPIC_AUTH_TOKEN` 答 `oauth_token`(2.1.284 实测),与
   * `claude setup-token` 的订阅令牌**逐字相同** —— 只问 CLI 的话,这类用户永远是「订阅登录」。
   */
  function settingsFs(settings: unknown, extra: Record<string, unknown> = {}) {
    return {
      read: vi.fn(async (path: string) =>
        path === '.claude/settings.json' ? JSON.stringify(settings) : null
      ),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
      ...extra,
    };
  }

  it('reads a relay token from Claude Code’s own settings env as a user-supplied key (#1163)', async () => {
    const exec = vi.fn();

    await expect(
      claudeAuthStatus(
        ctx({
          exec,
          fs: settingsFs({
            env: {
              ANTHROPIC_AUTH_TOKEN: 'PROXY_MANAGED',
              ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
            },
          }),
        })
      )
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'api-key' });
    expect(exec).not.toHaveBeenCalled();
  });

  it('reads an API key from the settings env the same way', async () => {
    await expect(
      claudeAuthStatus(ctx({ fs: settingsFs({ env: { ANTHROPIC_API_KEY: 'sk-ant-test' } }) }))
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'api-key' });
  });

  it('still asks the CLI when the settings env holds no credential of its own (#1163)', async () => {
    // 只把中转地址搬进 settings 的用户(令牌仍是订阅那一条)不算用户自己递的凭据:
    // 「中转在哪」与「谁给的钥匙」是两件事,这一格只判后者。
    const exec = statusExec({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' });

    await expect(
      claudeAuthStatus(
        ctx({ exec, fs: settingsFs({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721' } }) })
      )
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'subscription' });
    expect(exec).toHaveBeenCalledWith('claude', ['auth', 'status'], { timeout: 5000 });
  });

  it('does not read a settings.json that is not the config root Claude Code reads (#1163)', async () => {
    // 用户自己导出了 `CLAUDE_CONFIG_DIR`:手上这把 fs 锚在真 OS home 上,而 Claude Code 读的是那个变量
    // 指的根。那时 `.claude/settings.json` 是**另一个账号**的配置 —— 读它比读不到更糟。
    const read = vi.fn(async () => JSON.stringify({ env: { ANTHROPIC_AUTH_TOKEN: 'other-account' } }));
    const exec = statusExec({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' });

    await expect(
      claudeAuthStatus(ctx({ env: { CLAUDE_CONFIG_DIR: '/elsewhere/claude' }, exec, fs: settingsFs({}, { read }) }))
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'subscription' });
    expect(read).not.toHaveBeenCalled();
  });

  it('reads the settings env when Gugu itself set the config root (#1163)', async () => {
    // 连接保管目录(独立 home)时 fs 与配置根成对:`fsFollowsConfigRoot` 说的就是这件事。
    await expect(
      claudeAuthStatus(
        ctx({
          env: { CLAUDE_CONFIG_DIR: '/vault/claude' },
          fsFollowsConfigRoot: true,
          fs: settingsFs({ env: { ANTHROPIC_AUTH_TOKEN: 'vault-token' } }),
        })
      )
    ).resolves.toEqual({ kind: 'authenticated', credentialKind: 'api-key' });
  });

  it('falls back to the CLI when the settings file cannot be read (#1163)', async () => {
    // 「读不出来」不是「没有凭据」:读数退回 CLI,❌ 不因此改口说「没登录」。
    const exec = statusExec({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' });
    const fs = settingsFs({}, { read: vi.fn(async () => null) });

    await expect(claudeAuthStatus(ctx({ exec, fs }))).resolves.toEqual({
      kind: 'authenticated',
      credentialKind: 'subscription',
    });
  });
});
