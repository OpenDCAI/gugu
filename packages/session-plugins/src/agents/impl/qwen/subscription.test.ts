import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { describe, expect, it, vi } from 'vitest';
import {
  BAILIAN_CONSOLE_URL,
  MODELSTUDIO_CODING_PLAN_CONSOLE_URL,
  readQwenPlan,
  readQwenUsage,
} from './subscription';

const SETTINGS = '.qwen/settings.json';

function ctx(settings: unknown, env: Record<string, string> = {}): AgentAuthContext {
  return {
    cli: 'qwen',
    env,
    exec: vi.fn(),
    fs: {
      read: vi.fn(async (path: string) =>
        path === SETTINGS && settings !== undefined ? (typeof settings === 'string' ? settings : JSON.stringify(settings)) : null
      ),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  };
}

/** Qwen 的 `/auth` 选了阿里云预设后写进用户 settings 的形状(字段名取自 0.21.15 的预设代码)。 */
function configured(baseUrl: string, envKey: string, model = 'qwen3.7-plus') {
  return {
    $version: 4,
    security: { auth: { selectedType: 'openai' } },
    model: { name: model },
    modelProviders: { openai: [{ id: model, name: model, baseUrl, envKey }] },
    env: { [envKey]: 'sk-sp-secret' },
  };
}

describe('Qwen Code 订阅读数', () => {
  it('本机 10-13 实测的那份(只有 $version)= 没配自己的账号', async () => {
    await expect(readQwenPlan(ctx({ $version: 4 }))).resolves.toEqual({ payer: 'not-signed-in' });
    await expect(readQwenPlan(ctx(undefined))).resolves.toEqual({ payer: 'not-signed-in' });
  });

  it('百炼 Coding Plan ⇒ 订阅、档位读不出，余量去阿里云控制台(中国站)', async () => {
    const reading = await readQwenPlan(ctx(configured('https://coding.dashscope.aliyuncs.com/v1', 'BAILIAN_CODING_PLAN_API_KEY')));
    expect(reading).toEqual({ payer: 'subscription', plan: '百炼 Coding Plan', tierUnknown: true });
    expect(JSON.stringify(reading)).not.toContain('secret');
    await expect(
      readQwenUsage(ctx(configured('https://coding.dashscope.aliyuncs.com/v1', 'BAILIAN_CODING_PLAN_API_KEY')), reading)
    ).resolves.toMatchObject({ reason: 'vendor-console', consoleUrl: BAILIAN_CONSOLE_URL });
  });

  it('国际站 Coding Plan ⇒ 链到国际站控制台', async () => {
    const settings = configured('https://coding-intl.dashscope.aliyuncs.com/v1', 'BAILIAN_CODING_PLAN_API_KEY');
    const reading = await readQwenPlan(ctx(settings));
    await expect(readQwenUsage(ctx(settings), reading)).resolves.toMatchObject({
      consoleUrl: MODELSTUDIO_CODING_PLAN_CONSOLE_URL,
    });
  });

  it('百炼 Token Plan、按量、别家地址各归各类', async () => {
    await expect(
      readQwenPlan(ctx(configured('https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1', 'BAILIAN_TOKEN_PLAN_API_KEY')))
    ).resolves.toEqual({ payer: 'subscription', plan: '百炼 Token Plan', tierUnknown: true });
    await expect(
      readQwenPlan(ctx(configured('https://dashscope.aliyuncs.com/compatible-mode/v1', 'DASHSCOPE_API_KEY')))
    ).resolves.toEqual({ payer: 'api-key', plan: '阿里云百炼按量' });
    await expect(
      readQwenPlan(ctx(configured('https://relay.example.com/v1?k=1', 'OPENAI_API_KEY')))
    ).resolves.toEqual({ payer: 'custom-endpoint', endpoint: 'relay.example.com' });
  });

  it('Qwen OAuth 已停用 ⇒ 判不出并说明', async () => {
    await expect(
      readQwenPlan(ctx({ security: { auth: { selectedType: 'qwen-oauth' } } }))
    ).resolves.toMatchObject({ payer: 'unknown', message: expect.stringContaining('2026-04-15') });
  });

  it('QWEN_HOME 挪走了配置根 ⇒ 判不出', async () => {
    await expect(readQwenPlan(ctx({ $version: 4 }, { QWEN_HOME: '/x' }))).resolves.toMatchObject({ payer: 'unknown' });
  });
});
