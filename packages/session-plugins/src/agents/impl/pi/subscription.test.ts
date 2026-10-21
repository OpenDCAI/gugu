import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { readPiPlan, readPiUsage } from './subscription';

const AUTH = '.pi/agent/auth.json';

function ctx(auth: unknown, env: Record<string, string> = {}): AgentAuthContext {
  return {
    cli: 'pi',
    env,
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) => (path === AUTH && auth !== undefined ? JSON.stringify(auth) : null)),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  };
}

function chatgptJwt(planType: string): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: planType } })
  ).toString('base64url');
  return `h.${payload}.s`;
}

describe('Pi 订阅读数', () => {
  it('本机 10-13 实测：auth.json 是 {}、没有 key 环境变量 ⇒ 没登任何一家', async () => {
    const reading = await readPiPlan(ctx({}));
    expect(reading).toEqual({ payer: 'not-signed-in' });
    await expect(readPiUsage(ctx({}), reading)).resolves.toMatchObject({ reason: 'not-signed-in' });
  });

  it('Claude 订阅登 Pi ⇒ 标出扣的是额外用量', async () => {
    await expect(
      readPiPlan(ctx({ anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 } }))
    ).resolves.toEqual({ payer: 'subscription', plan: 'Claude', tierUnknown: true, via: ['Claude'], extraUsage: true });
  });

  it('ChatGPT 订阅登 Pi ⇒ 档位从令牌里解', async () => {
    await expect(
      readPiPlan(
        ctx({
          'openai-codex': { type: 'oauth', refresh: 'r', access: chatgptJwt('plus'), expires: 1, accountId: 'x' },
          anthropic: { type: 'oauth', refresh: 'r', access: 'a', expires: 1 },
        })
      )
    ).resolves.toEqual({
      payer: 'subscription',
      plan: 'ChatGPT Plus',
      via: ['ChatGPT', 'Claude'],
      extraUsage: true,
    });
  });

  it('只有 key(含 OpenRouter 的 OAuth 铸 key)⇒ 按量', async () => {
    await expect(
      readPiPlan(ctx({ openrouter: { type: 'oauth', access: 'a' }, google: { type: 'api_key', key: 'k' } }))
    ).resolves.toEqual({ payer: 'api-key', via: ['OpenRouter', 'Google Gemini'] });
    await expect(readPiPlan(ctx(undefined, { ANTHROPIC_API_KEY: 'sk' }))).resolves.toEqual({ payer: 'api-key', via: ['Claude'] });
  });

  it('PI_CODING_AGENT_DIR 挪走了配置根 ⇒ 判不出', async () => {
    await expect(readPiPlan(ctx({}, { PI_CODING_AGENT_DIR: '/x' }))).resolves.toMatchObject({ payer: 'unknown' });
  });
});
