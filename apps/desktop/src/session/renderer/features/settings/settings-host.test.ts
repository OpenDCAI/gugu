import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const local = vi.hoisted(() => ({
  getWithMeta: vi.fn(async () => ({ value: { tmuxByDefault: false }, defaults: {}, overrides: {} })),
  update: vi.fn(async () => undefined),
}));
/** d22 上同一个 `appSettings.*`(rpcOn(机器) 送过去)。 */
const d22 = vi.hoisted(() => ({
  getWithMeta: vi.fn(async () => ({ value: { tmuxByDefault: true }, defaults: {}, overrides: {} })),
  update: vi.fn(async () => undefined),
  reset: vi.fn(async () => undefined),
  resetField: vi.fn(async () => undefined),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { appSettings: local },
  rpcOn: () => ({ appSettings: d22 }),
  events: { on: () => () => {} },
}));

const { createMachineSettingsHost, SettingsHostProvider } = await import('./settings-host');
const { useAppSettingsKey } = await import('./use-app-settings-key');
const { DeviceSettingsTag } = await import('./components/DeviceSettingsScope');
const { LOCAL_SETTINGS_HOST } = await import('./settings-host');

type Api = ReturnType<typeof useAppSettingsKey<'project'>>;

describe('设置里跟机器走的那几组(默认 tmux、仓库)跟着所选机器(#6264)', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  let api: Api | undefined;

  function Probe() {
    api = useAppSettingsKey('project');
    return null;
  }

  async function mount(host: Parameters<typeof SettingsHostProvider>[0]['value']) {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            SettingsHostProvider,
            { value: host },
            React.createElement(Probe),
            React.createElement(DeviceSettingsTag)
          )
        )
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  function remote(online = true) {
    return { host: createMachineSettingsHost({ deviceId: 'd22', deviceLabel: 'Linux 1', online, lastSeenAt: null }) };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  it('选了 d22:读与写都是 d22 上的,本机的设置一问不发、一格不改', async () => {
    const { host } = remote();
    await mount(host);
    expect(api?.value).toEqual({ tmuxByDefault: true });
    await act(async () => {
      api!.update({ tmuxByDefault: false });
      await vi.advanceTimersByTimeAsync(50);
    });
    expect(d22.update).toHaveBeenCalledWith('project', { tmuxByDefault: false });
    expect(local.getWithMeta).not.toHaveBeenCalled();
    expect(local.update).not.toHaveBeenCalled();
  });

  it('d22 离线:不去问,开关灰着(当作还不能动)', async () => {
    const { host } = remote(false);
    await mount(host);
    expect(d22.getWithMeta).not.toHaveBeenCalled();
    expect(api?.isLoading).toBe(true);
  });

  it('页里只有这一行按机器:选了 d22 时行标题旁标出机器名,本机时不标', async () => {
    const tag = () => dom.window.document.querySelector('[data-slot="device-settings-tag"]')?.textContent ?? null;
    await mount(remote().host);
    expect(tag()).toBe('Linux 1');
    await mount(LOCAL_SETTINGS_HOST);
    expect(tag()).toBeNull();
  });
});
