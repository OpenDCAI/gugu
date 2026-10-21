import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LibraryHostProvider, type LibraryAgentsRpc, type LibraryHost } from '@renderer/features/library/library-host';
import { useManagementAgents } from './use-agents';
import { useAgentInstallationStatuses, useBusyInstallAgents } from './use-agent-installation-statuses';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// 本机那一路:资源库选了别的机器时,这里一个都不该被调到。
const local = vi.hoisted(() => ({
  list: vi.fn(async () => []),
  listManagement: vi.fn(async () => []),
  listAgentInstallationStatus: vi.fn(async () => []),
  install: vi.fn(async () => ({ success: true, data: {} })),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { agents: local, mcp: {} },
  events: { on: () => () => {} },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));

type FakeAgents = { [K in keyof LibraryAgentsRpc]: ReturnType<typeof vi.fn> };

function remoteAgents(): FakeAgents {
  const fn = <T,>(value: T) => vi.fn(async () => value);
  return {
    listManagement: fn([
      { id: 'claude', name: 'Claude Code', status: 'available', reading: 'installed', updateAvailable: false, installOptions: [] },
    ]),
    getManagement: fn(null),
    listAgentInstallationStatus: fn([{ id: 'claude', status: 'available', reading: 'installed', installations: [] }]),
    install: fn({ success: true, data: {} }),
    update: fn({ success: true, data: {} }),
    uninstall: fn({ success: true, data: {} }),
    cancelInstall: fn(true),
    probeAll: fn(undefined),
    refreshLatestVersion: fn(undefined),
    getInstallSourceVersions: fn({}),
    setUsedInstallation: fn(undefined),
    probeOverride: fn(null),
    getSettings: fn(null),
    getDefaultSettings: fn(null),
    updateSettings: fn(undefined),
    onInstallProgress: vi.fn(() => () => undefined),
  } as never;
}

function remoteHost(agents: FakeAgents, online: boolean): LibraryHost {
  return {
    key: 'remote:d22',
    agents: agents as unknown as LibraryAgentsRpc,
    prompts: { get: vi.fn(), update: vi.fn() } as never,
    mcpLibrary: {} as never,
    integrations: {} as never,
    github: {} as never,
    extensions: {} as never,
    remote: { deviceId: 'd22', deviceLabel: 'Linux 1', online, lastSeenAt: null },
  };
}

type Api = {
  list: ReturnType<typeof useManagementAgents>;
  statuses: ReturnType<typeof useAgentInstallationStatuses>;
  busy: ReadonlySet<string>;
};

function Probe({ onReady }: { onReady: (api: Api) => void }) {
  onReady({ list: useManagementAgents(), statuses: useAgentInstallationStatuses(), busy: useBusyInstallAgents() });
  return React.createElement('div');
}

describe('资源库选了别的机器时,取数与动作都去那台机器(#6264)', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  let api: Api | undefined;

  async function mount(host: LibraryHost) {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            SessionLocalizationProvider,
            null,
            React.createElement(
              LibraryHostProvider,
              { value: host },
              React.createElement(Probe, { onReady: (value: Api) => void (api = value) })
            )
          )
        )
      );
    });
  }

  async function settle() {
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
    vi.stubGlobal('Event', dom.window.Event);
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

  it('列表与安装状态读的是那台机器报的,❌ 本机的', async () => {
    const agents = remoteAgents();
    await mount(remoteHost(agents, true));
    await settle();
    expect(agents.listManagement).toHaveBeenCalled();
    expect(agents.listAgentInstallationStatus).toHaveBeenCalled();
    expect(local.listManagement).not.toHaveBeenCalled();
    expect(local.listAgentInstallationStatus).not.toHaveBeenCalled();
    expect(api?.list.data?.map((a) => [a.id, a.reading])).toEqual([['claude', 'installed']]);
  });

  it('点「安装」装在那台机器上;进行中只挂在那台机器的网格上', async () => {
    const agents = remoteAgents();
    let finish: (value: unknown) => void = () => undefined;
    agents.install.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    await mount(remoteHost(agents, true));
    await settle();
    act(() => api!.statuses.install({ id: 'codex' as never, method: 'mise', registry: undefined }));
    await settle();
    expect(agents.install).toHaveBeenCalledWith('codex', 'mise', undefined);
    expect(local.install).not.toHaveBeenCalled();
    expect(api?.busy.has('codex')).toBe(true);
    // 本机那份进行中的集合里没有它(按机器分,❌ 本机网格也转进度环)。
    expect(queryClient.getMutationCache().getAll()[0]?.options.mutationKey).toEqual(['agents', 'install', 'remote:d22']);
    await act(async () => {
      finish({ success: true, data: {} });
      await vi.advanceTimersByTimeAsync(50);
    });
  });

  it('那台机器离线:一问都不发(问不到只会挂满超时),页面只读', async () => {
    const agents = remoteAgents();
    await mount(remoteHost(agents, false));
    await settle();
    expect(agents.listManagement).not.toHaveBeenCalled();
    expect(agents.listAgentInstallationStatus).not.toHaveBeenCalled();
    expect(api?.list.fetchStatus).toBe('idle');
  });

  it('没有挂资源库的机器(composer、会话页)= 本机,照旧问本机', async () => {
    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(
            SessionLocalizationProvider,
            null,
            React.createElement(Probe, { onReady: (value: Api) => void (api = value) })
          )
        )
      );
    });
    await settle();
    expect(local.listManagement).toHaveBeenCalled();
    expect(local.listAgentInstallationStatus).toHaveBeenCalled();
  });
});
