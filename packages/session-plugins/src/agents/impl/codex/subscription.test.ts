import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { customProviderOf, planFromAuthJson, readCodexPlan, readCodexUsage, windowsFromUsage } from './subscription';

const requestUsage = vi.hoisted(() => vi.fn());
vi.mock('../../helpers/subscription-http', () => ({ requestSubscriptionJson: requestUsage }));

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(payload)}.sig`;
}

const chatgptAuth = (planType: string) => ({
  auth_mode: 'chatgpt',
  tokens: { id_token: jwt({ 'https://api.openai.com/auth': { chatgpt_plan_type: planType } }) },
});

/** fs 锚在 home:只有 `.codex/` 下这两份文件有内容(与 `createLocalPluginFs` 同约定，不存在 ⇒ null)。 */
function ctx(files: Record<string, string>, overrides: Partial<AgentAuthContext> = {}): AgentAuthContext {
  return {
    cli: 'codex',
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

describe('Codex 套餐', () => {
  it('ChatGPT 登录:按令牌里的 plan_type 认，Pro 三档分得开', () => {
    expect(planFromAuthJson(chatgptAuth('prolite'))).toEqual({ payer: 'subscription', plan: 'ChatGPT Pro 100' });
    expect(planFromAuthJson(chatgptAuth('pro'))).toEqual({ payer: 'subscription', plan: 'ChatGPT Pro 200' });
    expect(planFromAuthJson(chatgptAuth('promax'))).toEqual({ payer: 'subscription', plan: 'ChatGPT Pro 500' });
    // Codex 自己把 business 显示成 Enterprise、team 才是 Business(subscription.rs)。
    expect(planFromAuthJson(chatgptAuth('business'))).toEqual({ payer: 'subscription', plan: 'ChatGPT Enterprise' });
    expect(planFromAuthJson(chatgptAuth('someday_new_plan'))).toEqual({
      payer: 'subscription',
      plan: 'ChatGPT',
      tierUnknown: true,
    });
  });

  it('API key / 没登录 / 认不出的模式', () => {
    expect(planFromAuthJson({ auth_mode: 'apikey', OPENAI_API_KEY: 'sk-***' })).toEqual({ payer: 'api-key' });
    expect(planFromAuthJson(null)).toEqual({ payer: 'not-signed-in' });
    expect(planFromAuthJson({ auth_mode: 'future' })).toEqual({ payer: 'unknown' });
  });

  it('选了自定义 provider ⇒ 自定义服务，判的是 id 不是名字(本机的形状:id 与名字都叫 OpenAI)', () => {
    const toml = [
      'model_provider = "OpenAI"',
      '[model_providers.OpenAI]',
      'name = "OpenAI"',
      'base_url = "http://relay.example.com:9000"',
      'wire_api = "responses"',
    ].join('\n');
    expect(customProviderOf(toml)).toBe('relay.example.com:9000');
    expect(customProviderOf('model_provider = "openai"')).toBeNull();
    expect(customProviderOf('model = "gpt-6"')).toBeNull();
    expect(customProviderOf('model_provider = "mine"')).toBe('mine');
  });

  it('readCodexPlan 读 ~/.codex 下的两份文件;自定义 provider 优先于登录', async () => {
    await expect(
      readCodexPlan(ctx({ '.codex/auth.json': JSON.stringify(chatgptAuth('plus')) }))
    ).resolves.toEqual({ payer: 'subscription', plan: 'ChatGPT Plus' });
    await expect(
      readCodexPlan(
        ctx({
          '.codex/auth.json': JSON.stringify(chatgptAuth('plus')),
          '.codex/config.toml': 'model_provider = "relay"\n[model_providers.relay]\nbase_url = "https://r.example.com/v1"',
        })
      )
    ).resolves.toEqual({ payer: 'custom-endpoint', endpoint: 'r.example.com' });
    // 旧实现读 home 下的 auth.json(#7146)—— 那里的文件不作数。
    await expect(readCodexPlan(ctx({ 'auth.json': JSON.stringify(chatgptAuth('plus')) }))).resolves.toEqual({
      payer: 'not-signed-in',
    });
    await expect(
      readCodexPlan(ctx({ '.codex/auth.json': JSON.stringify(chatgptAuth('plus')) }, { env: { CODEX_HOME: '/x' } }))
    ).resolves.toMatchObject({ payer: 'unknown' });
  });
});

describe('Codex 用量', () => {
  it('不是 ChatGPT 订阅就不起 app-server', async () => {
    await expect(readCodexUsage(ctx({}, { cli: '/nonexistent/codex' }), { payer: 'custom-endpoint', endpoint: 'x' }))
      .resolves.toMatchObject({ kind: 'unavailable', reason: 'custom-endpoint' });
    await expect(readCodexUsage(ctx({}, { cli: '/nonexistent/codex' }), { payer: 'api-key' }))
      .resolves.toMatchObject({ kind: 'unavailable', reason: 'not-reported' });
  });

  it('reads both windows from the same wham/usage response as cockpit-tools', async () => {
    requestUsage.mockResolvedValue({ rate_limit: {
      primary_window: { used_percent: 14, limit_window_seconds: 18000, reset_at: 1792200000 },
      secondary_window: { used_percent: 26, limit_window_seconds: 604800, reset_after_seconds: 3600 },
    }});
    const files = { '.codex/auth.json': JSON.stringify({ ...chatgptAuth('pro'), tokens: { access_token: 'test-access', account_id: 'test-account' } }) };
    const reading = await readCodexUsage(ctx(files), { payer: 'subscription', plan: 'ChatGPT Pro 200' });
    expect(reading).toMatchObject({ kind: 'windows', windows: [
      { windowMinutes: 300, usedPercent: 14, resetsAt: 1792200000000 },
      { windowMinutes: 10080, usedPercent: 26 },
    ]});
    expect(requestUsage).toHaveBeenLastCalledWith(expect.anything(), 'https://chatgpt.com/backend-api/wham/usage', {
      authorization: 'Bearer test-access', 'ChatGPT-Account-Id': 'test-account',
    });
  });

  it('does not invent absent windows, preserves unknown durations and additional groups', () => {
    expect(windowsFromUsage({ rate_limit: {
      primary_window: null,
      secondary_window: { used_percent: 40, limit_window_seconds: 604800, reset_at: 100 },
    }, additional_rate_limits: [{ limit_name: 'Spark', rate_limit: { primary_window: { used_percent: 2, reset_after_seconds: 60 } } }] }, 1000)).toEqual([
      { windowMinutes: 10080, usedPercent: 40, resetsAt: 100000 },
      { group: 'Spark', usedPercent: 2, resetsAt: 61000 },
    ]);
  });

  it('reports quota request failure with the vendor link', async () => {
    requestUsage.mockRejectedValue(new Error('额度查询失败（HTTP 429）。'));
    const files = { '.codex/auth.json': JSON.stringify({ tokens: { access_token: 'test-access' } }) };
    await expect(readCodexUsage(ctx(files), { payer: 'subscription' })).resolves.toMatchObject({ kind: 'unavailable', reason: 'error', consoleUrl: 'https://chatgpt.com/codex/settings/usage' });
  });
});



it('an official API connection is not attributed to a cached ChatGPT subscription', async () => {
  const files = {
    '.codex/auth.json': JSON.stringify(chatgptAuth('plus')),
    '.codex/config.toml': 'model_provider = "gugu_connection"\n[model_providers.gugu_connection]\nbase_url = "https://api.openai.com/v1"',
  };
  await expect(readCodexPlan(ctx(files, { env: { OPENAI_API_KEY: 'key' } }))).resolves.toEqual({ payer: 'api-key' });
  await expect(readCodexPlan(ctx(files))).resolves.toEqual({ payer: 'custom-endpoint', endpoint: 'api.openai.com' });
});
