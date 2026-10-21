import { describe, expect, it, vi } from 'vitest';

const local = vi.hoisted(() => ({
  listManagement: vi.fn(),
  install: vi.fn(),
  acquireAuthorization: vi.fn(async () => ({ success: true, credentials: { accessToken: 'tok' } })),
  cancelAuthorization: vi.fn(async () => undefined),
}));

/** d22 上同一套控制器(rpcOn(机器) 送过去)。每一问记成 [命名空间.动词, 参数]。 */
const d22 = vi.hoisted(() => {
  const calls: Array<[string, unknown[]]> = [];
  const answers: Record<string, unknown> = {
    'agents.listManagement': [
      { id: 'claude', name: 'Claude Code', status: 'available', reading: 'installed', version: '2.1.0' },
      { id: 'codex', name: 'Codex', status: 'missing', reading: 'not-detected', version: null },
    ],
    'integrations.connect': { success: true },
    'integrations.checkAllConnections': { feishu: { connected: true } },
  };
  /** 那台机器对某个动词的报错(老 server 不认的动词回 `unknown_method`)。 */
  const failures: Record<string, unknown> = {};
  const client = new Proxy(
    {},
    {
      get: (_t, ns: string) =>
        new Proxy(
          {},
          {
            get: (_u, verb: string) =>
              vi.fn(async (...args: unknown[]) => {
                calls.push([`${ns}.${verb}`, args]);
                if (`${ns}.${verb}` in failures) throw failures[`${ns}.${verb}`];
                return answers[`${ns}.${verb}`] ?? { success: true, data: null };
              }),
          }
        ),
    }
  );
  return { calls, client, failures, events: [] as Array<{ machine: string | null; name: string; cb: (data: unknown) => void }> };
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: { listManagement: local.listManagement, install: local.install },
    integrations: { acquireAuthorization: local.acquireAuthorization, cancelAuthorization: local.cancelAuthorization },
  },
  rpcOn: (machine: string | null) => (machine === 'd22' ? d22.client : {}),
  onMachineEvent: (machine: string | null, event: { name: string }, cb: (data: unknown) => void) => {
    d22.events.push({ machine, name: event.name, cb });
    return () => undefined;
  },
  events: { on: () => () => {} },
}));

const { createRemoteLibraryHost, LOCAL_LIBRARY_HOST, machineLibraryHost } = await import('./library-host');

const device = { deviceId: 'd22', deviceLabel: 'Linux 1', online: true, lastSeenAt: null };
const verbs = () => d22.calls.map(([verb]) => verb);

describe('资源库的取数对象(#6264 一套工作台:同一套控制器,rpc 送到那台机器)', () => {
  it('本机:键是 local、没有远端那一格', () => {
    expect(LOCAL_LIBRARY_HOST.key).toBe('local');
    expect(LOCAL_LIBRARY_HOST.remote).toBeNull();
  });

  it('别的机器的列表 = 那台机器报的读数,❌ 问本机', async () => {
    d22.calls.length = 0;
    const host = createRemoteLibraryHost(device);
    const list = await host.agents.listManagement();
    expect(verbs()).toEqual(['agents.listManagement']);
    expect(local.listManagement).not.toHaveBeenCalled();
    expect(list.map((a) => [a.id, a.reading])).toEqual([
      ['claude', 'installed'],
      ['codex', 'not-detected'],
    ]);
    expect(host.key).toBe('remote:d22');
    expect(host.remote).toMatchObject({ deviceId: 'd22', deviceLabel: 'Linux 1', online: true });
  });

  it('装 / 升级 / 卸载 / 检测 / 用哪一份,都是那台机器上同名同参的调用', async () => {
    d22.calls.length = 0;
    const host = createRemoteLibraryHost(device);
    await host.agents.install('codex', 'mise', 'npmmirror');
    await host.agents.update('claude');
    await host.agents.uninstall('claude', 'mise');
    await host.agents.probeAll();
    await host.agents.setUsedInstallation('claude', null as never);
    await host.agents.cancelInstall('codex');
    expect(d22.calls).toEqual([
      ['agents.install', ['codex', 'mise', 'npmmirror']],
      ['agents.update', ['claude', undefined, undefined]],
      ['agents.uninstall', ['claude', 'mise']],
      ['agents.probeAll', []],
      // null = 明确回到自动,❌ 被吃成「没给」
      ['agents.setUsedInstallation', ['claude', null]],
      ['agents.cancelInstall', ['codex']],
    ]);
    expect(local.install).not.toHaveBeenCalled();
  });

  it('安装进度 / GitHub 设备码只听那台机器推的那一路', () => {
    d22.events.length = 0;
    const host = createRemoteLibraryHost(device);
    host.agents.onInstallProgress(() => undefined);
    host.github.onEvent({ name: 'github:auth:device-code' } as never, () => undefined);
    expect(d22.events.map((e) => e.machine)).toEqual(['d22', 'd22']);
  });

  it('集成的浏览器授权:在这台电脑上授权(回调只能落在这里),拿到的凭据交给那台机器的 connect', async () => {
    d22.calls.length = 0;
    const host = createRemoteLibraryHost(device);
    await expect(host.integrations.authorize('linear')).resolves.toEqual({ success: true });
    expect(local.acquireAuthorization).toHaveBeenCalledWith('linear');
    expect(d22.calls).toEqual([['integrations.connect', ['linear', { accessToken: 'tok' }]]]);
    local.acquireAuthorization.mockResolvedValueOnce({ success: false, error: 'denied' } as never);
    d22.calls.length = 0;
    await expect(host.integrations.authorize('linear')).resolves.toEqual({ success: false, error: 'denied' });
    expect(d22.calls).toEqual([]);
    await host.integrations.cancelAuthorization('linear');
    expect(local.cancelAuthorization).toHaveBeenCalledWith('linear');
  });

  it('集成连没连上问那台机器的 integrations.*:覆盖每一家,不只 issue 系统(#7210)', async () => {
    d22.calls.length = 0;
    const host = createRemoteLibraryHost(device);
    await expect(host.integrations.checkAllConnections()).resolves.toEqual({ feishu: { connected: true } });
    expect(verbs()).toEqual(['integrations.checkAllConnections']);
  });

  it('那台机器不认这个动词(太旧)也照原样报给页面,❌ 改问老动词把它盖掉', async () => {
    d22.calls.length = 0;
    const tooOld = Object.assign(new Error('unknown method'), { code: 'unknown_method' });
    d22.failures['integrations.checkAllConnections'] = tooOld;
    try {
      const host = createRemoteLibraryHost(device);
      await expect(host.integrations.checkAllConnections()).rejects.toBe(tooOld);
      expect(verbs()).toEqual(['integrations.checkAllConnections']);
    } finally {
      delete d22.failures['integrations.checkAllConnections'];
    }
  });

  it('别的失败照原样报给页面', async () => {
    d22.calls.length = 0;
    const timeout = Object.assign(new Error('timed out'), { name: 'DeviceRpcTimeoutError' });
    d22.failures['integrations.checkConfiguredConnections'] = timeout;
    try {
      const host = createRemoteLibraryHost(device);
      await expect(host.integrations.checkConfiguredConnections()).rejects.toBe(timeout);
      expect(verbs()).toEqual(['integrations.checkConfiguredConnections']);
    } finally {
      delete d22.failures['integrations.checkConfiguredConnections'];
    }
  });

  it('按机器认同一份;那台机器上下线了换一份(取数钩子据 online 决定问不问)', () => {
    const a = machineLibraryHost(device);
    expect(machineLibraryHost({ ...device })).toBe(a);
    const offline = machineLibraryHost({ ...device, online: false });
    expect(offline).not.toBe(a);
    expect(offline.remote?.online).toBe(false);
    expect(machineLibraryHost(null)).toBe(LOCAL_LIBRARY_HOST);
  });
});
