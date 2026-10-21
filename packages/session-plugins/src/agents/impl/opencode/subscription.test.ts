import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { OPENCODE_CONSOLE_URL, readOpencodePlan, readOpencodeUsage } from './subscription';

const AUTH = '.local/share/opencode/auth.json';

function ctx(files: Record<string, string>, env: Record<string, string> = {}): AgentAuthContext {
  return {
    cli: 'opencode',
    env,
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) => files[path] ?? null),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  };
}

/** 只为测判读：载荷里放 ChatGPT 的 plan 声明，签名段随便填(读法本来就不验签)。 */
function chatgptJwt(planType: string): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: planType } })
  ).toString('base64url');
  return `eyJhbGciOiJub25lIn0.${payload}.sig`;
}

describe('OpenCode 订阅读数', () => {
  it('没有 auth.json = 这台机器没登过任何 provider', async () => {
    await expect(readOpencodePlan(ctx({}))).resolves.toEqual({ payer: 'not-signed-in' });
  });

  it('opencode-go 的 key ⇒ OpenCode Go 订阅，档位(Go / Go Plus)读不出', async () => {
    const reading = await readOpencodePlan(
      ctx({ [AUTH]: JSON.stringify({ 'opencode-go': { type: 'api', key: 'sk-test' } }) })
    );
    expect(reading).toEqual({ payer: 'subscription', plan: 'OpenCode Go', tierUnknown: true, via: ['OpenCode Go'] });
    expect(JSON.stringify(reading)).not.toContain('sk-test');
    await expect(readOpencodeUsage(ctx({}), reading)).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'vendor-console',
      consoleUrl: OPENCODE_CONSOLE_URL,
    });
  });

  it('ChatGPT 登录 ⇒ 按令牌里的 plan 声明给厂商自己的名字', async () => {
    const reading = await readOpencodePlan(
      ctx({
        [AUTH]: JSON.stringify({
          openai: { type: 'oauth', access: chatgptJwt('prolite'), refresh: 'r', expires: 1, accountId: 'a' },
          openrouter: { type: 'api', key: 'k' },
        }),
      })
    );
    expect(reading).toEqual({ payer: 'subscription', plan: 'ChatGPT Pro 100', via: ['OpenAI', 'OpenRouter'] });
    await expect(readOpencodeUsage(ctx({}), reading)).resolves.toMatchObject({ reason: 'not-reported' });
  });

  it('只有 Zen ⇒ 按量付费', async () => {
    await expect(
      readOpencodePlan(ctx({ [AUTH]: JSON.stringify({ opencode: { type: 'api', key: 'k' } }) }))
    ).resolves.toEqual({ payer: 'api-key', plan: 'OpenCode Zen', via: ['OpenCode Zen'] });
  });

  it('读不出的文件 ⇒ 判不出，❌ 当成没登录', async () => {
    await expect(readOpencodePlan(ctx({ [AUTH]: '{not json' }))).resolves.toMatchObject({ payer: 'unknown' });
  });

  it('数据根被 XDG_DATA_HOME 挪走而 fs 不随根走 ⇒ 判不出', async () => {
    await expect(
      readOpencodePlan(ctx({ [AUTH]: JSON.stringify({ opencode: { type: 'api', key: 'k' } }) }, { XDG_DATA_HOME: '/x' }))
    ).resolves.toMatchObject({ payer: 'unknown' });
  });
});
