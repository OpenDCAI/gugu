import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentInstallProgressChannel, agentInstallationStatusUpdatedChannel } from '@shared/events/appEvents';
import { useAgentInstallationStatus, useAgentInstallationStatuses } from './use-agent-installation-statuses';
import { LibraryHostProvider, LOCAL_LIBRARY_HOST } from '@renderer/features/library/library-host';
import { useConnectionAvailability } from '@renderer/features/settings/subscriptions/use-connection-availability';
import { subscriptionKey } from '@renderer/features/settings/subscriptions/subscription-queries';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  listAgentInstallationStatus: vi.fn(),
  install: vi.fn(),
  update: vi.fn(),
  on: vi.fn<(channel: unknown, listener: (event: unknown) => void) => () => void>(() => () => {}),
  refreshLatestVersion: vi.fn(),
  probeAll: vi.fn(),
  refreshAuthStatus: vi.fn(),
}));

vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async (machine: string | null) => ({
    refreshAuthStatus: (input: { providerId: string }) => mocks.refreshAuthStatus(machine, input),
  }),
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: {
    agents: {
      listAgentInstallationStatus: mocks.listAgentInstallationStatus,
      install: mocks.install,
      update: mocks.update,
      refreshLatestVersion: mocks.refreshLatestVersion,
      probeAll: mocks.probeAll,
    },
  },
  events: { on: mocks.on },
}));

vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn() }));

vi.mock('./use-agents', () => ({
  AGENTS_METADATA_QUERY_KEY: ['agents', 'metadata'] as const,
  useAgents: () => ({ data: [] }),
}));

const SOURCE_VERSIONS_KEY = ['agents', 'install-source-versions', 'claude', 'local'] as const;

type Api = ReturnType<typeof useAgentInstallationStatuses>;

function Probe({ onReady }: { onReady: (api: Api) => void }) {
  onReady(useAgentInstallationStatuses());
  return React.createElement('div');
}

/**
 * The per-registry version numbers are a third cache, separate from the status query and the
 * agents metadata query, and they carry a 30-minute staleTime. Leaving them out of invalidate()
 * left the user with no way to refresh them: a source could read "outdated" forever while
 * "check for updates" re-ran and changed nothing on screen.
 *
 * Fake timers throughout — react-dom and react-query both schedule work on timers that would
 * otherwise fire after the teardown below has removed `window`, failing the run from outside
 * any test.
 */
describe('useAgentInstallationStatuses invalidate', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;
  let queryClient: QueryClient;
  let api: Api | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    mocks.listAgentInstallationStatus.mockResolvedValue([]);
    mocks.install.mockResolvedValue({ success: true, data: {} });
    mocks.refreshLatestVersion.mockResolvedValue(undefined);
    mocks.probeAll.mockResolvedValue(undefined);
    mocks.refreshAuthStatus.mockResolvedValue({ success: true, data: { kind: 'unknown' } });

    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);

    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);

    await act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          // 结果提示现在走 catalog(toast 标题与失败文案都不再是硬编码英文),所以这个 hook
          // 真的需要 localization provider —— 缺它会在 useSessionMessages 处抛,而不是静默降级。
          React.createElement(
            SessionLocalizationProvider,
            null,
            React.createElement(Probe, {
              onReady: (value: Api) => {
                api = value;
              },
            })
          )
        )
      );
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  async function settle() {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(50);
    });
  }

  let availability: ReturnType<typeof useConnectionAvailability>;
  async function renderAvailability(machine: string | null, providerId = 'codex') {
    function Availability() {
      availability = useConnectionAvailability(providerId, machine);
      return null;
    }
    const host = machine ? {
      ...LOCAL_LIBRARY_HOST,
      key: `remote:${machine}`,
      remote: { deviceId: machine, deviceLabel: machine, online: true, lastSeenAt: null },
    } : LOCAL_LIBRARY_HOST;
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(SessionLocalizationProvider, null,
          // LibraryMainPanel remounts its host subtree when the selected device changes.
          React.createElement(LibraryHostProvider, { value: host, key: host.key },
            React.createElement(Probe, { onReady: (value: Api) => { api = value; } }),
            React.createElement(Availability)))));
    });
    await settle();
  }

  it('re-reads the open connection after installation through the existing cache refresh', async () => {
    let installed = false;
    mocks.refreshAuthStatus.mockImplementation(async () => ({
      success: true, data: { kind: installed ? 'unauthenticated' : 'unknown' },
    }));
    let finish!: (value: { success: true; data: object }) => void;
    mocks.install.mockImplementation(() => {
      installed = true;
      const statusEvent = mocks.on.mock.calls.find(([channel]) => channel === agentInstallationStatusUpdatedChannel);
      statusEvent![1]({ id: 'codex', reading: 'installed', installations: [] });
      return new Promise(resolve => { finish = resolve; });
    });
    await renderAvailability(null);
    expect(availability.state).toBe('failed');

    let operation!: Promise<unknown>;
    await act(async () => { operation = api!.installAsync({ id: 'codex', method: 'mise' }); });
    await settle();
    expect(mocks.refreshAuthStatus).toHaveBeenCalledTimes(1);
    await act(async () => { finish({ success: true, data: {} }); await operation; });
    await settle();

    expect(availability.auth?.kind).toBe('unauthenticated');
    expect(availability.state).toBe('unusable');
    expect(mocks.refreshAuthStatus).toHaveBeenCalledTimes(2);
  });

  it('keeps the actual unknown reading when installation fails', async () => {
    mocks.install.mockResolvedValue({ success: false, error: { type: 'no-install-command' } });
    await renderAvailability(null);

    await act(async () => { await api!.installAsync({ id: 'codex', method: 'mise' }); });
    await settle();

    expect(availability.auth).toEqual({ kind: 'unknown' });
    expect(availability.state).toBe('failed');
  });

  it('preserves an authentication read error after a successful install', async () => {
    await renderAvailability(null);
    mocks.refreshAuthStatus.mockRejectedValue(new Error('Authentication read failed'));

    await act(async () => { await api!.installAsync({ id: 'codex', method: 'mise' }); });
    await settle();

    expect(availability.state).toBe('failed');
    expect(availability.error?.message).toBe('Authentication read failed');
    expect(availability.auth?.kind).not.toBe('authenticated');
  });

  it.each([
    { machine: 'server-b', providerId: 'codex' },
    { machine: 'server-a', providerId: 'claude' },
  ])('refreshes the initiating host/provider after switching to $machine/$providerId', async (other) => {
    let installed = false;
    mocks.refreshAuthStatus.mockImplementation(async (machine: string, { providerId }: { providerId: string }) => ({
      success: true, data: { kind: machine === 'server-a' && providerId === 'codex' && installed ? 'unauthenticated' : 'unknown' },
    }));
    let finish!: (value: { success: true; data: object }) => void;
    mocks.install.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await renderAvailability('server-a');
    let operation!: Promise<unknown>;
    await act(async () => { operation = api!.installAsync({ id: 'codex', method: 'mise' }); });
    await renderAvailability(other.machine, other.providerId);
    const otherReads = () => mocks.refreshAuthStatus.mock.calls.filter(([machine, input]) =>
      machine === other.machine && input.providerId === other.providerId);
    expect(otherReads()).toHaveLength(1);

    await act(async () => { installed = true; finish({ success: true, data: {} }); await operation; });
    await settle();

    expect(otherReads()).toHaveLength(1);
    expect(queryClient.getQueryState([...subscriptionKey('server-a', 'codex'), 'availability'])?.isInvalidated).toBe(true);
    expect(availability.auth).toEqual({ kind: 'unknown' });
    await renderAvailability('server-a');
    expect(availability.auth?.kind).toBe('unauthenticated');
    expect(otherReads()).toHaveLength(1);
  });

  it('keeps a pending recheck scoped when the host subtree remounts', async () => {
    let finish!: () => void;
    mocks.probeAll.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    await renderAvailability('server-a');
    await act(async () => { api!.probeAll(); });
    await renderAvailability('server-b');

    await act(async () => { finish(); });
    await settle();

    expect(mocks.refreshAuthStatus.mock.calls.filter(([machine]) => machine === 'server-b')).toHaveLength(1);
    expect(queryClient.getQueryState([...subscriptionKey('server-a', 'codex'), 'availability'])?.isInvalidated).toBe(true);
  });

  it('subscribes to progress while updating and clears it when the update settles', async () => {
    let complete!: (value: { success: true; data: object }) => void;
    mocks.update.mockReturnValue(new Promise(resolve => { complete = resolve; }));
    let status!: ReturnType<typeof useAgentInstallationStatus>;
    function AgentProbe() { status = useAgentInstallationStatus('claude'); return null; }
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client: queryClient },
        React.createElement(SessionLocalizationProvider, null, React.createElement(AgentProbe))));
    });
    let operation!: Promise<void>;
    await act(async () => { operation = status.update('mise', 'npmmirror'); });
    await settle();
    expect(status.isUpdating).toBe(true);
    expect(status.isInstalling).toBe(false);
    const subscription = mocks.on.mock.calls.find(call => call[0] === agentInstallProgressChannel);
    expect(subscription).toBeDefined();
    const progress = { providerId: 'claude', phase: 'downloading', elapsedMs: 3000, bytesDone: 1000, bytesTotal: 5000 };
    await act(async () => { (subscription![1] as (event: unknown) => void)(progress); });
    expect(status.installProgress).toEqual(progress);
    await act(async () => { complete({ success: true, data: {} }); await operation; });
    await settle();
    expect(status.isUpdating).toBe(false);
    expect(status.installProgress).toBeNull();
  });

  it('marks the per-registry version cache stale after an install', async () => {
    queryClient.setQueryData(SOURCE_VERSIONS_KEY, {
      npmmirror: { version: '1.0.0', outdated: true },
    });
    expect(queryClient.getQueryState(SOURCE_VERSIONS_KEY)?.isInvalidated).toBe(false);

    await act(async () => {
      api?.install({ id: 'claude' as never, method: 'npm', registry: 'npmmirror' });
    });
    await settle();

    expect(queryClient.getQueryState(SOURCE_VERSIONS_KEY)?.isInvalidated).toBe(true);
  });

  it('marks it stale after an explicit check for updates', async () => {
    queryClient.setQueryData(SOURCE_VERSIONS_KEY, {
      npmmirror: { version: '1.0.0', outdated: true },
    });

    await act(async () => {
      api?.refreshLatestVersion('claude');
    });
    await settle();

    expect(queryClient.getQueryState(SOURCE_VERSIONS_KEY)?.isInvalidated).toBe(true);
  });
  /**
   * #5719 owner 真机实测:装完之后「资源库 → 智能体」那张列表仍旧画着「未安装」,要切换页面
   * 或者重启应用才更新;点 ⟳ 重新检测也不管用。主进程那边没有问题 —— 同一时刻
   * `listAgentInstallationStatus` 已经报 available,是界面手里那份缓存没被作废。
   *
   * 徽标读的是 `agent.status`(AgentRow.tsx:8),来自 `useManagementAgents()` 的
   * `['agents','management']`,而它挂着 5 分钟 staleTime。这两条判据钉的就是那个键。
   */
  const MANAGEMENT_KEY = ['agents', 'management'] as const;

  it('装完之后，智能体列表那份缓存也被标脏（否则徽标要等切页面/重启）', async () => {
    queryClient.setQueryData(MANAGEMENT_KEY, [{ id: 'claude', status: 'unavailable' }]);
    expect(queryClient.getQueryState(MANAGEMENT_KEY)?.isInvalidated).toBe(false);

    await act(async () => {
      api?.install({ id: 'claude' as never, method: 'npm', registry: 'npmmirror' });
    });
    await settle();

    expect(queryClient.getQueryState(MANAGEMENT_KEY)?.isInvalidated).toBe(true);
  });

  it('⟳ 重新检测之后同样标脏', async () => {
    queryClient.setQueryData(MANAGEMENT_KEY, [{ id: 'claude', status: 'unavailable' }]);

    await act(async () => {
      api?.probeAll();
    });
    await settle();

    expect(queryClient.getQueryState(MANAGEMENT_KEY)?.isInvalidated).toBe(true);
  });

  /**
   * 这条判的是**结构**,不是某一个键:作废按 `['agents', …]` 前缀整体来,所以将来新加的派生缓存
   * 不必回到 invalidate() 里补登记。第三个键是故意编的 —— 它代表「还没被写出来的那个查询」,
   * 只有前缀作废能覆盖它,逐条列举必然漏。
   */
  it('这一族里每一个都被覆盖，包括还没写出来的那个', async () => {
    const keys = [
      ['agents', 'metadata'],
      ['agents', 'management'],
      ['agents', 'icons'],
      ['agents', 'modelCatalog'],
      ['agents', 'modelCredential'],
      ['agents', 'install-source-versions', 'claude', 'local'],
      ['agents', 'some-future-derived-cache'],
    ] as const;
    for (const key of keys) queryClient.setQueryData(key, {});

    await act(async () => {
      api?.probeAll();
    });
    await settle();

    const stale = keys.filter((key) => queryClient.getQueryState(key)?.isInvalidated);
    expect(stale).toHaveLength(keys.length);
  });
});
