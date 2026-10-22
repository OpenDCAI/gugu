import { describe, expect, it, vi } from 'vitest';

const local = vi.hoisted(() => ({
  setEnabled: vi.fn(),
  uninstall: vi.fn(),
  list: vi.fn(),
  marketUpdates: vi.fn(async () => ({ success: true, data: { updates: {}, yanked: {}, deprecated: {} } })),
}));
const registry = vi.hoisted(() => ({
  registered: new Set<string>(),
  closed: [] as string[],
}));

/** 那台机器:同一个 `extensions.*` 控制器(rpcOn(机器) 送过去)。 */
const machine = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown[]]>,
  events: [] as Array<{ machine: string | null; name: string; cb: (data: unknown) => void }>,
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: local, app: { openSelectDirectoryDialog: vi.fn() } },
  rpcOn: (id: string) => ({
    extensions: new Proxy(
      {},
      {
        get: (_t, verb: string) => async (...args: unknown[]) => {
          machine.calls.push([id, verb, args]);
          if (verb === 'list') return { success: true, data: { extensions: [manifest('pomodoro')], invalid: [], icons: {}, disabled: [] } };
          if (verb === 'setEnabled') return { success: true, data: { disabled: ['pomodoro'] } };
          return { success: true };
        },
      }
    ),
  }),
  onMachineEvent: (id: string | null, event: { name: string }, cb: (data: unknown) => void) => {
    machine.events.push({ machine: id, name: event.name, cb });
    return () => undefined;
  },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/features/sessions/session-tab-registry', () => ({
  sessionTabRegistry: {
    has: (kind: string) => registry.registered.has(kind),
    register: (provider: { kind: string }) => registry.registered.add(provider.kind),
    unregister: (kind: string) => registry.registered.delete(kind),
    closeKind: (kind: string) => registry.closed.push(kind),
  },
}));
vi.mock('./extension-tab-provider', () => ({
  createExtensionTabProvider: (extensionId: string, tabName: string) => ({ kind: `${extensionId}.${tabName}` }),
}));

const { createRemoteExtensionsHost, LOCAL_EXTENSIONS_HOST } = await import('./extensions-host');
const { setExtensionEnabled } = await import('./set-extension-enabled');
const { installedExtensionsStore } = await import('./installed-extensions-store');
const { resyncInstalledExtensionTabs } = await import('./register-extension-tabs');

function manifest(id: string) {
  return ({ id, name: id, version: '1.0.0', contributes: { tabs: [{ name: 'main', title: 'Main' }] } }) as never;
}

describe('资源库 → 扩展看另一台咕咕桌面(#6264)', () => {
  it('清单、开关、卸载、从市场装都去那台机器;清单是它自己的一份,❌ 动本机那份', async () => {
    const host = createRemoteExtensionsHost('mac2', async () => null);
    await host.store.load();
    expect(host.store.manifests.map((m) => m.id)).toEqual(['pomodoro']);
    expect(host.store).not.toBe(installedExtensionsStore);
    expect(local.list).not.toHaveBeenCalled();
    await host.api.installFromMarket({ ref: { extensionId: 'pomodoro', version: '1.0.0' }, consent: { kind: 'return' } });
    await host.api.installFromFolder({ sourceDir: '/tmp/x', consent: { kind: 'given', digest: 'd' } });
    expect(machine.calls.map((c) => [c[0], c[1]])).toEqual([
      ['mac2', 'list'],
      ['mac2', 'installFromMarket'],
      ['mac2', 'installFromFolder'],
    ]);
    // 同一台机器再建一次(在线状态变了会重建)拿到的是同一份清单,❌ 从骨架重来。
    expect(createRemoteExtensionsHost('mac2', async () => null).store).toBe(host.store);
  });

  it('开关 / 卸载那台机器的:改的是那台的清单,这个窗口的 tab 一个不动(那台机器自己的窗口跟进)', async () => {
    const host = createRemoteExtensionsHost('mac3', async () => null);
    registry.registered.add('pomodoro.main');
    await setExtensionEnabled(manifest('pomodoro'), false, host);
    expect(host.store.disabled).toEqual(['pomodoro']);
    await host.api.uninstall({ extensionId: 'pomodoro' });
    expect(local.setEnabled).not.toHaveBeenCalled();
    expect(local.uninstall).not.toHaveBeenCalled();
    expect(registry.registered.has('pomodoro.main')).toBe(true);
    expect(registry.closed).toEqual([]);
  });

  it('下载进度只听那台机器推的那一路', () => {
    const host = createRemoteExtensionsHost('mac4', async () => null);
    host.onEvent({ name: 'extensions.market.download-progress' }, () => undefined);
    expect(machine.events.at(-1)).toMatchObject({ machine: 'mac4', name: 'extensions.market.download-progress' });
  });
  // 本机那一页只听本机推的(市场刷新「没取到」不该让本机那页写「上次更新于」)。
  // 别的机器的推送也合流进同一个频道:本机那一页只听本机的(市场刷新「没取到」不该让本机那页写「上次更新于」)。
  it('本机那一页也只听本机推的那一路', () => {
    LOCAL_EXTENSIONS_HOST.onEvent({ name: 'extensions.market.refreshed' }, () => undefined);
    expect(machine.events.at(-1)).toMatchObject({ machine: null, name: 'extensions.market.refreshed' });
  });

  it('「从文件夹安装」挑的是那台机器上的文件夹', async () => {
    const pick = vi.fn(async () => '/home/me/ext');
    const host = createRemoteExtensionsHost('mac5', pick);
    await expect(host.pickFolder({ title: 't', message: 'm' })).resolves.toBe('/home/me/ext');
    expect(pick).toHaveBeenCalledWith('mac5', '~');
  });
});

describe('这台机器的扩展被别的桌面改了:窗口跟上(#6264)', () => {
  it('新装的补上 tab;关掉的连 tab 一起关;卸掉的撤下(开着的退回占位)', async () => {
    registry.registered.clear();
    registry.closed.length = 0;
    local.list.mockResolvedValueOnce({
      success: true,
      data: { extensions: [manifest('a'), manifest('b'), manifest('c')], invalid: [], icons: {}, disabled: [] },
    });
    await installedExtensionsStore.load();
    for (const id of ['a', 'b', 'c']) registry.registered.add(`${id}.main`);
    // 别处:b 被关了、c 被卸了、d 新装了。
    local.list.mockResolvedValueOnce({
      success: true,
      data: { extensions: [manifest('a'), manifest('b'), manifest('d')], invalid: [], icons: {}, disabled: ['b'] },
    });
    await resyncInstalledExtensionTabs();
    expect([...registry.registered].sort()).toEqual(['a.main', 'd.main']);
    expect(registry.closed).toEqual(['b.main']);
  });
});
