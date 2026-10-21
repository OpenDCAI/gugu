import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import {
  claudePlanName,
  parseClaudeUsageText,
  parseResetTime,
  planFromAuthStatus,
  readClaudePlan,
  readClaudeUsage,
  windowsFromClaudeUsage,
} from './subscription';

const requestUsage = vi.hoisted(() => vi.fn());
vi.mock('../../helpers/subscription-http', () => ({ requestSubscriptionJson: requestUsage }));

/** 夹具一律照 Claude Code 2.1.296 本机实测的输出形状(邮箱等打码)。 */
const SIGNED_IN_MAX = {
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'user@example.com',
  orgId: 'org-1',
  orgName: 'Example',
  subscriptionType: 'max',
};

const USAGE_TEXT = [
  'You are currently using your subscription to power your Claude Code usage',
  '',
  'Current session: 18% used · resets Oct 13 at 6:59am (Asia/Shanghai)',
  'Current week (all models): 84% used · resets Oct 14 at 3:59am (Asia/Shanghai)',
  'Current week (Fable): 18% used · resets Oct 14 at 3:59am (Asia/Shanghai)',
  '',
  "What's contributing to your limits usage?",
].join('\n');

function ctx(overrides: Partial<AgentAuthContext> & { files?: Record<string, string> } = {}): AgentAuthContext {
  const files = overrides.files ?? {};
  return {
    cli: 'claude',
    env: {},
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) => files[path] ?? null),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
    ...overrides,
  };
}

describe('Claude 套餐', () => {
  it('Max 订阅按 .claude.json 的档位分出 20x / 5x', () => {
    expect(
      planFromAuthStatus(SIGNED_IN_MAX, { organizationType: 'claude_max', rateLimitTier: 'default_claude_max_20x', asOf: 1 })
    ).toEqual({ payer: 'subscription', plan: 'Claude Max 20x', planAsOf: 1 });
    expect(claudePlanName('max', { rateLimitTier: 'default_claude_max_5x' })).toEqual({
      name: 'Claude Max 5x',
      fromTier: true,
    });
  });

  it('认不出的档位只写到家族，不猜', () => {
    expect(planFromAuthStatus(SIGNED_IN_MAX, null)).toEqual({
      payer: 'subscription',
      plan: 'Claude Max',
      tierUnknown: true,
    });
    expect(claudePlanName(undefined, { rateLimitTier: 'default_claude_max_20x' }).tierUnknown).toBe(true);
  });

  it('Pro / 长期令牌 / key / 第三方云 / 没登录', () => {
    expect(planFromAuthStatus({ ...SIGNED_IN_MAX, subscriptionType: 'pro' }, null)).toEqual({
      payer: 'subscription',
      plan: 'Claude Pro',
    });
    expect(planFromAuthStatus({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }, null)).toEqual({
      payer: 'subscription',
      plan: 'Claude',
      tierUnknown: true,
    });
    expect(
      planFromAuthStatus({ loggedIn: true, authMethod: 'api_key', apiKeySource: '/login managed key' }, null)
    ).toEqual({ payer: 'api-key' });
    expect(planFromAuthStatus({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }, null)).toEqual({
      payer: 'custom-endpoint',
      endpoint: 'bedrock',
    });
    expect(planFromAuthStatus({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }, null)).toEqual({
      payer: 'not-signed-in',
    });
  });

  it('readClaudePlan 读 auth status 与 .claude.json(没登录时 exit 1 的那份 JSON 也认)', async () => {
    const files = {
      '.claude.json': JSON.stringify({
        oauthAccount: {
          organizationType: 'claude_max',
          organizationRateLimitTier: 'default_claude_max_20x',
          profileFetchedAt: '2026-10-12T14:29:00.000Z',
        },
      }),
    };
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify(SIGNED_IN_MAX, null, 2), stderr: '' });
    await expect(readClaudePlan(ctx({ exec, files }))).resolves.toEqual({
      payer: 'subscription',
      plan: 'Claude Max 20x',
      planAsOf: Date.parse('2026-10-12T14:29:00.000Z'),
    });

    const signedOut = vi.fn().mockRejectedValue({
      code: 1,
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' }),
    });
    await expect(readClaudePlan(ctx({ exec: signedOut }))).resolves.toEqual({ payer: 'not-signed-in' });
  });

  it('用户挪了 CLAUDE_CONFIG_DIR 而 fs 照不到 ⇒ 不读 .claude.json,只认到家族', async () => {
    const files = { '.claude.json': JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_20x' } }) };
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify(SIGNED_IN_MAX), stderr: '' });
    await expect(
      readClaudePlan(ctx({ exec, files, env: { CLAUDE_CONFIG_DIR: '/elsewhere' } }))
    ).resolves.toMatchObject({ plan: 'Claude Max', tierUnknown: true });
  });

  it('reads the selected connection’s tier inside its own config directory', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: JSON.stringify(SIGNED_IN_MAX), stderr: '' });
    await expect(readClaudePlan(ctx({ exec, env: { CLAUDE_CONFIG_DIR: '/owned/work/.claude' }, fsFollowsConfigRoot: true,
      files: { '.claude/.claude.json': JSON.stringify({ oauthAccount: { organizationRateLimitTier: 'default_claude_max_5x' } }) },
    }))).resolves.toMatchObject({ plan: 'Claude Max 5x' });
  });

  it('ANTHROPIC_BASE_URL 指到别处 ⇒ 自定义服务，只给主机名', async () => {
    await expect(
      readClaudePlan(ctx({ env: { ANTHROPIC_BASE_URL: 'https://relay.example.com/v1?token=secret' } }))
    ).resolves.toEqual({ payer: 'custom-endpoint', endpoint: 'relay.example.com' });
  });
});

describe('Claude 用量', () => {
  const now = new Date('2026-10-12T20:00:00Z'); // 北京时间 10-13 04:00

  it('/usage 正文解成 5 小时与每周两种窗口，分组照它自己的写法', () => {
    expect(parseClaudeUsageText(USAGE_TEXT, now)).toEqual([
      { windowMinutes: 300, usedPercent: 18, resetsAt: Date.parse('2026-10-12T22:59:00Z') },
      { group: 'all models', windowMinutes: 10_080, usedPercent: 84, resetsAt: Date.parse('2026-10-13T19:59:00Z') },
      { group: 'Fable', windowMinutes: 10_080, usedPercent: 18, resetsAt: Date.parse('2026-10-13T19:59:00Z') },
    ]);
  });

  it('重置时刻:按括号里的时区解，没日期就是当天，跨年取下一年', () => {
    expect(parseResetTime('6:59am (Asia/Shanghai)', now)).toBe(Date.parse('2026-10-12T22:59:00Z'));
    expect(parseResetTime('Jan 2 at 1pm (UTC)', new Date('2026-12-31T00:00:00Z'))).toBe(Date.parse('2027-01-02T13:00:00Z'));
    expect(parseResetTime('someday', now)).toBeUndefined();
    expect(parseResetTime('6:59am (Not/AZone)', now)).toBeUndefined();
  });

  it('queries structured OAuth usage automatically, without starting a Claude conversation', async () => {
    const exec = vi.fn();
    requestUsage.mockResolvedValue({ five_hour: { utilization: 18, resets_at: '2026-10-17T18:30:00Z' }, seven_day: { utilization: 84 }, seven_day_sonnet: { utilization: 12 } });
    const reading = await readClaudeUsage(ctx({ exec, env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } }), { payer: 'subscription' });
    expect(reading).toMatchObject({ kind: 'windows', windows: [
      { windowMinutes: 300, usedPercent: 18, resetsAt: Date.parse('2026-10-17T18:30:00Z') },
      { windowMinutes: 10080, usedPercent: 84 },
      { windowMinutes: 10080, group: 'sonnet', usedPercent: 12 },
    ] });
    expect(exec).not.toHaveBeenCalled();
    expect(requestUsage).toHaveBeenLastCalledWith(expect.anything(), 'https://api.anthropic.com/api/oauth/usage', {
      authorization: 'Bearer test-token', 'anthropic-beta': 'oauth-2025-04-20', 'user-agent': 'gugu',
    });
    requestUsage.mockClear();
    await expect(readClaudeUsage(ctx({ exec }), { payer: 'api-key' })).resolves.toMatchObject({ kind: 'unavailable', reason: 'not-reported' });
    expect(requestUsage).not.toHaveBeenCalled();
  });

  it('does not turn missing, null or unknown quota into zero', () => {
    expect(windowsFromClaudeUsage({ five_hour: null, seven_day: { utilization: 0 }, seven_day_opus: { utilization: 'unknown' } })).toEqual([{ windowMinutes: 10080, usedPercent: 0 }]);
  });

  it('a failed usage request is explicit', async () => {
    requestUsage.mockRejectedValue(new Error('额度查询失败（HTTP 429）。'));
    await expect(readClaudeUsage(ctx({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' } }), { payer: 'subscription' })).resolves.toMatchObject({ kind: 'unavailable', reason: 'error', message: '额度查询失败（HTTP 429）。' });
  });
});
