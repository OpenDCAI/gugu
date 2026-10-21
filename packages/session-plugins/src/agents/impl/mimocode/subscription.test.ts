import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import { MIMO_CONSOLE_URL, readMimocodePlan, readMimocodeUsage } from './subscription';

const AUTH = '.local/share/mimocode/auth.json';

function ctx(files: Record<string, string>, env: Record<string, string> = {}, fsFollowsConfigRoot = false): AgentAuthContext {
  return {
    cli: 'mimo',
    env,
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) => files[path] ?? null),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
    fsFollowsConfigRoot,
  };
}

/** 本机 10-13 实测形状(浏览器登录后落盘;key 换成假值)。 */
function xiaomi(key: string, baseUrl = 'https://api.xiaomimimo.com/v1', id = 'xiaomi') {
  return JSON.stringify({ [id]: { type: 'api', key, metadata: { uid: '1', base_url: baseUrl } } });
}

describe('MiMo Code 订阅读数', () => {
  it('sk- 开头 = 按量付费(浏览器登录也可能拿到这种),余额去小米后台', async () => {
    const reading = await readMimocodePlan(ctx({ [AUTH]: xiaomi('sk-secret-123') }));
    expect(reading).toEqual({ payer: 'api-key', plan: 'MiMo 按量付费' });
    expect(JSON.stringify(reading)).not.toContain('secret');
    await expect(readMimocodeUsage(ctx({}), reading)).resolves.toMatchObject({
      reason: 'vendor-console',
      consoleUrl: MIMO_CONSOLE_URL,
    });
  });

  it('tp- 开头 = Token Plan 个人版;ttp- = 团队版;档位读不出', async () => {
    await expect(readMimocodePlan(ctx({ [AUTH]: xiaomi('tp-abc', 'https://token-plan-cn.xiaomimimo.com/v1') }))).resolves.toEqual({
      payer: 'subscription',
      plan: 'MiMo Token Plan',
      tierUnknown: true,
    });
    await expect(readMimocodePlan(ctx({ [AUTH]: xiaomi('ttp-abc') }))).resolves.toEqual({
      payer: 'subscription',
      plan: 'MiMo Token Plan 团队版',
      tierUnknown: true,
    });
  });

  it('地址不是小米的 = 自定义服务，只给主机名', async () => {
    const reading = await readMimocodePlan(ctx({ [AUTH]: xiaomi('sk-x', 'https://relay.example.com:9000/v1?token=zzz') }));
    expect(reading).toEqual({ payer: 'custom-endpoint', endpoint: 'relay.example.com:9000' });
    await expect(readMimocodeUsage(ctx({}), reading)).resolves.toMatchObject({ reason: 'custom-endpoint' });
  });

  it('没有凭据 / 挪走了数据根', async () => {
    await expect(readMimocodePlan(ctx({}))).resolves.toEqual({ payer: 'not-signed-in' });
    await expect(readMimocodePlan(ctx({ [AUTH]: '{}' }))).resolves.toEqual({ payer: 'not-signed-in' });
    await expect(readMimocodePlan(ctx({ [AUTH]: xiaomi('sk-x') }, { MIMOCODE_HOME: '/elsewhere' }))).resolves.toMatchObject({
      payer: 'unknown',
    });
    // 独立 home:变量是咕咕设的、fs 正锚在它上 ⇒ 照常判。
    await expect(
      readMimocodePlan(ctx({ [AUTH]: xiaomi('sk-x') }, { MIMOCODE_HOME: '/managed' }, true))
    ).resolves.toMatchObject({ payer: 'api-key' });
  });
});
