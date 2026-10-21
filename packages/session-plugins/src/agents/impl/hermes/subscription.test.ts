import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { parseHermesModelBlock, readHermesPlan, readHermesUsage } from './subscription';

const HOME = process.platform === 'win32' ? 'AppData/Local/hermes' : '.hermes';

function ctx(files: Record<string, unknown>, env: Record<string, string> = {}): AgentAuthContext {
  return {
    cli: 'hermes',
    env,
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) => {
        const value = files[path];
        if (value === undefined) return null;
        return typeof value === 'string' ? value : JSON.stringify(value);
      }),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  };
}

/** 照 Hermes 自带 `cli-config.yaml.example` 的 model 块形状。 */
const config = (provider: string, baseUrl = 'https://openrouter.ai/api/v1') => `# Hermes config
model:
  # Default model to use
  default: "anthropic/claude-opus-4.6"
  provider: "${provider}"   # inference provider
  base_url: "${baseUrl}"

terminal:
  provider: "local"
`;

function chatgptJwt(planType: string): string {
  const payload = Buffer.from(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_plan_type: planType } })
  ).toString('base64url');
  return `h.${payload}.s`;
}

describe('Hermes 订阅读数', () => {
  it('只认 model 块里的 provider / base_url,别的块里的同名键不算', () => {
    expect(parseHermesModelBlock(config('nous'))).toEqual({ provider: 'nous', baseUrl: 'https://openrouter.ai/api/v1' });
    expect(parseHermesModelBlock('terminal:\n  provider: "local"\n')).toEqual({});
  });

  it('本机 10-13 实测：~/.hermes 里没有 config.yaml / auth.json ⇒ 没配过', async () => {
    const reading = await readHermesPlan(ctx({}));
    expect(reading).toEqual({ payer: 'not-signed-in' });
    await expect(readHermesUsage(ctx({}), reading)).resolves.toMatchObject({ reason: 'not-signed-in' });
  });

  it('接 Nous Portal ⇒ 订阅，档位只有 Hermes 自己报(读不出),余量不报', async () => {
    const reading = await readHermesPlan(
      ctx({ [`${HOME}/config.yaml`]: config('nous'), [`${HOME}/auth.json`]: { version: 1, providers: { nous: { access_token: 'x' } } } })
    );
    expect(reading).toEqual({ payer: 'subscription', plan: 'Nous Portal', tierUnknown: true, via: ['Nous Portal'] });
    await expect(readHermesUsage(ctx({}), reading)).resolves.toMatchObject({ reason: 'not-reported' });
  });

  it('接 ChatGPT ⇒ 档位从存下的令牌里解', async () => {
    await expect(
      readHermesPlan(
        ctx({
          [`${HOME}/config.yaml`]: config('openai-codex'),
          [`${HOME}/auth.json`]: { providers: { 'openai-codex': { tokens: { access_token: chatgptJwt('pro'), refresh_token: 'r' } } } },
        })
      )
    ).resolves.toEqual({ payer: 'subscription', plan: 'ChatGPT Pro 200', via: ['ChatGPT'] });
  });

  it('anthropic 只给了 key(auth.json 里没有登录态)⇒ 按量;openrouter ⇒ 按量;自定义 ⇒ 写地址', async () => {
    await expect(readHermesPlan(ctx({ [`${HOME}/config.yaml`]: config('anthropic') }))).resolves.toEqual({
      payer: 'api-key',
      via: ['Claude'],
    });
    await expect(readHermesPlan(ctx({ [`${HOME}/config.yaml`]: config('openrouter') }))).resolves.toEqual({
      payer: 'api-key',
      via: ['OpenRouter'],
    });
    await expect(
      readHermesPlan(ctx({ [`${HOME}/config.yaml`]: config('custom', 'http://10.0.0.5:8080/v1') }))
    ).resolves.toEqual({ payer: 'custom-endpoint', endpoint: '10.0.0.5:8080' });
  });

  it('provider: auto 且判不出 ⇒ unknown;HERMES_HOME 挪走 ⇒ unknown', async () => {
    await expect(readHermesPlan(ctx({ [`${HOME}/config.yaml`]: config('auto') }))).resolves.toMatchObject({ payer: 'unknown' });
    await expect(readHermesPlan(ctx({}, { HERMES_HOME: '/x' }))).resolves.toMatchObject({ payer: 'unknown' });
  });
});
