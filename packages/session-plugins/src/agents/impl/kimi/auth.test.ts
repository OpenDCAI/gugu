// Vitest project: task-packages.
import { describe, expect, it, vi } from 'vitest';
import type { AgentAuthContext } from '@gugu/session-core/agents/plugins';
import { kimiAuthStatus } from './auth';
import { KIMI_CONFIG_PATH } from './hooks';
import { KIMI_HOME_ENV } from './session-bundle';

function ctx(options: {
  config?: string | null;
  readError?: Error;
  env?: Record<string, string>;
}): AgentAuthContext {
  return {
    cli: 'kimi',
    exec: vi.fn(),
    env: options.env ?? {},
    fs: {
      read: vi.fn(async (path: string) => {
        expect(path).toBe(KIMI_CONFIG_PATH);
        if (options.readError) throw options.readError;
        return options.config ?? null;
      }),
      write: vi.fn(),
      delete: vi.fn(),
      exists: vi.fn(),
      list: vi.fn(),
    },
  } as unknown as AgentAuthContext;
}

/** 一次成功的 `kimi login` 写下来的形状 —— 判据与厂商自己的 `persistedKimiOAuthRef()` 同源。 */
const LOGGED_IN = `
[providers."managed:kimi-code"]
oauth = { storage = "file", key = "oauth/kimi-code" }
`;

describe('kimiAuthStatus', () => {
  it('reads a persisted OAuth ref as signed in', async () => {
    expect(await kimiAuthStatus(ctx({ config: LOGGED_IN }))).toEqual({ kind: 'authenticated' });
  });

  it('calls a missing config file not signed in', async () => {
    // 这台机器上从没配过 Kimi —— 唯一一种「查不到」等于「真没有」的情形。
    const status = await kimiAuthStatus(ctx({ config: null }));
    expect(status.kind).toBe('unauthenticated');
  });

  it('refuses to call an API-key config "not signed in"', async () => {
    // Kimi 的凭据**不只**走 OAuth（官方文档:`KIMI_API_KEY` 等必须写进 config.toml，
    // 不从环境变量读）。照「没有 oauth ref 就是没登录」判，会把一个配好、跑得好好的用户
    // 恒定误报成未登录 —— 一个恒定误报的判据比没有判据更坏。
    const status = await kimiAuthStatus(
      ctx({ config: '[providers."custom"]\napi_key = "sk-whatever"\n' })
    );
    expect(status.kind).toBe('unknown');
  });

  it('refuses to judge when KIMI_CODE_HOME moved the config elsewhere', async () => {
    // 这条路的 PluginFs 根是 OS home;数据根被挪走时读的**不是同一份**文件。
    // ⚠️ 触发者只剩**用户自己**:咕咕自己已经不设这个变量了。
    const status = await kimiAuthStatus(
      ctx({ config: LOGGED_IN, env: { [KIMI_HOME_ENV]: '/tmp/run-scoped-home' } })
    );
    expect(status.kind).toBe('unknown');
  });

  it('does not turn a broken reader into a negative reading', async () => {
    // 读失败是「不知道」,❌ 不是「没登录」—— 拿失败的仪器当阴性读数。
    const status = await kimiAuthStatus(ctx({ readError: new Error('EACCES') }));
    expect(status.kind).toBe('unknown');
    expect(status.kind === 'unknown' && status.message).toContain('EACCES');
  });

  it('does not turn an unparseable config into a negative reading', async () => {
    const status = await kimiAuthStatus(ctx({ config: 'this is = = not toml [[[' }));
    expect(status.kind).toBe('unknown');
  });
});
