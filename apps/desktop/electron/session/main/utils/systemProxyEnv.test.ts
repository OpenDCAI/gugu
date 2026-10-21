import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => null }));

const PROXY_KEYS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'all_proxy', 'no_proxy'];

// #6892 系统代理只补给 agent 与它的安装器;用户终端与主进程环境一格不动。
describe('system proxy for agent processes', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    vi.resetModules();
    for (const key of PROXY_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });
  afterEach(() => {
    for (const key of PROXY_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it('reads the first PAC entry; DIRECT and SOCKS are reported, not guessed', async () => {
    const { proxyFromPac } = await import('./systemProxyEnv');
    expect(proxyFromPac('PROXY 127.0.0.1:7897; DIRECT')).toEqual({ proxy: 'http://127.0.0.1:7897' });
    expect(proxyFromPac('HTTPS proxy.corp:443')).toEqual({ proxy: 'https://proxy.corp:443' });
    expect(proxyFromPac('DIRECT')).toMatchObject({ proxy: null, reason: 'direct' });
    expect(proxyFromPac('SOCKS5 127.0.0.1:7891; DIRECT')).toMatchObject({ proxy: null, reason: 'unsupported' });
  });

  it('fills HTTPS/HTTP_PROXY, and NO_PROXY for loopback only when it fills a proxy', async () => {
    const { resolveSystemProxy, systemProxyFill } = await import('./systemProxyEnv');
    expect(systemProxyFill({})).toEqual({}); // not resolved yet
    await resolveSystemProxy(async () => 'DIRECT');
    expect(systemProxyFill({})).toEqual({});
    await resolveSystemProxy(async () => 'PROXY 127.0.0.1:7897');
    expect(systemProxyFill({})).toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:7897',
      HTTP_PROXY: 'http://127.0.0.1:7897',
      NO_PROXY: 'localhost,127.0.0.1,::1',
    });
    expect(systemProxyFill({ no_proxy: '.corp' })).not.toHaveProperty('NO_PROXY');
  });

  it('never overrides a proxy the user configured — in that env or in the login shell, any case', async () => {
    const { resolveSystemProxy, systemProxyFill } = await import('./systemProxyEnv');
    await resolveSystemProxy(async () => 'PROXY 127.0.0.1:7897');
    expect(systemProxyFill({ https_proxy: 'http://mine:1' })).toEqual({});
    expect(systemProxyFill({ ALL_PROXY: 'socks5://mine:2' })).toEqual({});
    expect(systemProxyFill({}, { HTTP_PROXY: 'http://rc:3' })).toEqual({});
  });

  it('agent env gets it; the user terminal env and process.env do not', async () => {
    const { resolveSystemProxy } = await import('./systemProxyEnv');
    const { buildAgentEnv, buildTerminalEnv } = await import('../core/pty/pty-env');
    await resolveSystemProxy(async () => 'PROXY 127.0.0.1:7897');
    expect(buildAgentEnv({ includeUserShellEnv: false }).HTTPS_PROXY).toBe('http://127.0.0.1:7897');
    expect(buildAgentEnv({ includeUserShellEnv: false, providerVars: { HTTPS_PROXY: 'http://set-in-agent-settings:9' } }).HTTPS_PROXY)
      .toBe('http://set-in-agent-settings:9');
    const terminal = buildTerminalEnv();
    expect(PROXY_KEYS.filter((key) => key in terminal)).toEqual([]);
    expect(PROXY_KEYS.filter((key) => key in process.env)).toEqual([]);
  });
});
