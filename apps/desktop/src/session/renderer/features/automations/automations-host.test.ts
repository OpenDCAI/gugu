import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const local = vi.hoisted(() => ({
  listAutomations: vi.fn(async () => [{ id: 'local-a' }]),
  createAutomation: vi.fn(),
  runAutomation: vi.fn(),
  getLatestRun: vi.fn(async () => null),
}));
const eventListeners = vi.hoisted(() => [] as Array<{ machine: string | null }>);
/** 那台机器上的同一组 `automations.*`(rpcOn(机器) 送过去)。 */
const d22 = vi.hoisted(() => ({
  listAutomations: vi.fn(async () => [{ id: 'd22-a' }]),
  createAutomation: vi.fn(async () => ({ id: 'saved' })),
  updateAutomationSettings: vi.fn(async () => ({ id: 'saved' })),
  runAutomation: vi.fn(async () => ({ id: 'saved' })),
  deleteAutomation: vi.fn(async () => ({ id: 'saved' })),
  getLatestRun: vi.fn(async () => ({ id: 'r1', status: 'done' })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { automations: local },
  rpcOn: (machine: string) => ({ automations: machine === 'd22' ? d22 : local }),
  onMachineEvent: (machine: string | null) => {
    eventListeners.push({ machine });
    return () => undefined;
  },
}));

const { AutomationsHostProvider, automationsQueryKey, createMachineAutomationsHost, LOCAL_AUTOMATIONS_HOST } = await import(
  './automations-host'
);
const { useAutomations, useLatestAutomationRun } = await import('./use-automations');

const device = { deviceId: 'd22', deviceLabel: 'Linux 1', online: true, lastSeenAt: null };

const sessionConfig = {
  version: '1' as const,
  sessionConfig: { version: '1' as const, name: 'daily' },
  workspaceConfig: { version: '2' as const, workspace: { kind: 'repository-instance' as const, workspaceId: 'local-ws' } },
};

describe('已安排看别的机器:取数与动作都去那台机器(#6264)', () => {
  it('本机:原样是本机的 rpc,缓存键不变(任务页上的运行胶囊读写同一份)', () => {
    expect(LOCAL_AUTOMATIONS_HOST.remote).toBeNull();
    expect(automationsQueryKey(LOCAL_AUTOMATIONS_HOST, 'runs', 'a1')).toEqual(['automations', 'runs', 'a1']);
    const remote = createMachineAutomationsHost(device);
    expect(automationsQueryKey(remote, 'runs', 'a1')).toEqual(['automations', 'remote:d22', 'runs', 'a1']);
  });

  it('建 / 改 / 立即运行 / 删:都是那台机器上同名同参的调用,本机一问不发', async () => {
    const host = createMachineAutomationsHost(device);
    await host.api.createAutomation({
      name: 'daily',
      projectId: 'p-d22',
      triggerConfig: { expr: '0 9 * * *' },
      agentConfig: { prompt: 'hi', provider: 'claude', autoApprove: true },
      sessionConfig,
    });
    await host.api.updateAutomationSettings('a1', { projectId: 'p-d22', sessionConfig });
    await host.api.runAutomation('a1');
    await host.api.deleteAutomation('a1');
    expect(d22.createAutomation).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p-d22', sessionConfig }));
    expect(d22.updateAutomationSettings).toHaveBeenCalledWith('a1', { projectId: 'p-d22', sessionConfig });
    expect(d22.runAutomation).toHaveBeenCalledWith('a1');
    expect(d22.deleteAutomation).toHaveBeenCalledWith('a1');
    expect(local.createAutomation).not.toHaveBeenCalled();
    expect(local.runAutomation).not.toHaveBeenCalled();
  });
});

describe('已安排的取数钩子跟着页头选的那台机器(#6264)', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  let seen: { list?: unknown; latest?: unknown } = {};

  function Probe() {
    seen = { list: useAutomations().automations.data, latest: useLatestAutomationRun('a1').data };
    return null;
  }

  async function mount(host: Parameters<typeof AutomationsHostProvider>[0]['value'] | null) {
    const probe = React.createElement(Probe);
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          host ? React.createElement(AutomationsHostProvider, { value: host }, probe) : probe
        )
      );
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    eventListeners.length = 0;
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  it('选了 d22:列表与最近一次运行读 d22 的,本机一问不发;只听 d22 推来的事件,❌ 轮询', async () => {
    await mount(createMachineAutomationsHost(device));
    expect(seen.list).toEqual([{ id: 'd22-a' }]);
    expect(seen.latest).toEqual({ id: 'r1', status: 'done' });
    expect(local.listAutomations).not.toHaveBeenCalled();
    expect(eventListeners.length).toBeGreaterThan(0);
    expect(eventListeners.every((listener) => listener.machine === 'd22')).toBe(true);
    const before = d22.listAutomations.mock.calls.length;
    focusManager.setFocused(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(d22.listAutomations.mock.calls.length).toBe(before);
    focusManager.setFocused(undefined);
  });

  it('d22 离线:一问都不发', async () => {
    await mount(createMachineAutomationsHost({ ...device, online: false }));
    expect(d22.listAutomations).not.toHaveBeenCalled();
    expect(d22.getLatestRun).not.toHaveBeenCalled();
  });

  it('本机(默认):读本机的,听本机的事件', async () => {
    await mount(null);
    expect(local.listAutomations).toHaveBeenCalled();
    expect(seen.list).toEqual([{ id: 'local-a' }]);
    expect(eventListeners.length).toBeGreaterThan(0);
    expect(eventListeners.every((listener) => listener.machine === null)).toBe(true);
  });
});
