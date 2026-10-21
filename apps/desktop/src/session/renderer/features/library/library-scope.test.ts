import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// #6264 owner:「整个资源库或者其他的都是分设备的」。资源库左栏顶上选了别的机器,**每一格**的取数都去那台机器;
// 本机这一路一个都不该被调到。反过来,没挂资源库机器的地方(输入框、聊天)照旧是本机。
const local = vi.hoisted(() => {
  const fn = <T,>(value: T) => vi.fn(async () => value);
  return {
    promptLibrary: { get: fn([{ id: 'local-prompt', title: 'L', text: 'l' }]), update: fn(undefined) },
    integrations: {
      list: fn([]),
      connect: fn({ success: true }),
      disconnect: fn({ success: true }),
      // 连没连上那两问在 integrations.* 上(#7210:覆盖每一家,不只 issue 系统)。
      checkAllConnections: fn({}),
      checkConfiguredConnections: fn({}),
    },
    github: { listAccounts: fn([]) },
    agents: { listManagement: fn([]), listAgentInstallationStatus: fn([]), listIcons: fn({}) },
  };
});

/** 那台机器:同一套控制器(rpcOn(机器) 送过去)。每一问记成 [机器, `命名空间.动词`, 参数]。 */
const machine = vi.hoisted(() => {
  const calls: Array<[string, string, unknown[]]> = [];
  const answer = (verb: string): unknown => {
    if (verb === 'promptLibrary.get') return [{ id: 'd22-prompt', title: 'R', text: 'r' }];
    if (verb === 'integrations.list') return [{ id: 'linear', name: 'Linear', features: [] }];
    if (verb === 'agents.listManagement') return [{ id: 'codex', name: 'Codex', reading: 'installed' }];
    if (verb.startsWith('agents.list') || verb.startsWith('github.list')) return [];
    return {};
  };
  const clientFor = (id: string) =>
    new Proxy(
      {},
      {
        get: (_t, ns: string) =>
          new Proxy(
            {},
            {
              get: (_u, verb: string) => async (...args: unknown[]) => {
                calls.push([id, `${ns}.${verb}`, args]);
                return answer(`${ns}.${verb}`);
              },
            }
          ),
      }
    );
  return { calls, clientFor };
});

vi.mock('@renderer/lib/ipc', () => ({
  rpc: local,
  rpcOn: (id: string | null) => (id ? machine.clientFor(id) : local),
  onMachineEvent: () => () => undefined,
  events: { on: () => () => {} },
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@renderer/lib/chat/chat-mention-provider', () => ({ registerIssueMentionIcons: vi.fn() }));
vi.mock('@renderer/features/settings/components/ExtensionsSettingsCard', () => ({
  ExtensionsSettingsCard: () => React.createElement('div', { 'data-testid': 'local-extensions' }),
}));

const { createRemoteLibraryHost, LibraryHostProvider } = await import('./library-host');
const { usePromptLibrary } = await import('./prompts/use-prompt-library');
const { IntegrationsProvider, useIntegrationsContext } = await import(
  '@renderer/features/integrations/integrations-provider'
);
const { useGitHubAccounts } = await import('@renderer/lib/hooks/useGithubAccounts');
const { useManagementAgents } = await import('@renderer/lib/stores/use-agents');
const { ExtensionsLibraryPage } = await import('./extensions-library-page');

type Seen = {
  prompts: ReturnType<typeof usePromptLibrary>;
  integrations: ReturnType<typeof useIntegrationsContext>;
  github: ReturnType<typeof useGitHubAccounts>;
  agents: ReturnType<typeof useManagementAgents>;
};

function Probe({ onReady }: { onReady: (seen: Seen) => void }) {
  onReady({
    prompts: usePromptLibrary(),
    integrations: useIntegrationsContext(),
    github: useGitHubAccounts(),
    agents: useManagementAgents(),
  });
  return null;
}

describe('资源库的机器选择管整个模块:每一格都跟着它(#6264)', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  let seen: Seen | undefined;

  function render(tree: React.ReactNode) {
    return act(async () => {
      root.render(
        React.createElement(
          QueryClientProvider,
          { client: queryClient },
          React.createElement(SessionLocalizationProvider, null, tree)
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
    machine.calls.length = 0;
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

  const probe = () => React.createElement(Probe, { onReady: (value: Seen) => void (seen = value) });

  it('选了 d22:提示词、集成(含连没连上)、GitHub、智能体全去 d22,本机一问都不发', async () => {
    const host = createRemoteLibraryHost({ deviceId: 'd22', deviceLabel: 'Linux 1', online: true, lastSeenAt: null });
    await render(
      React.createElement(
        LibraryHostProvider,
        { value: host },
        React.createElement(IntegrationsProvider, null, probe())
      )
    );
    await settle();
    const verbs = new Set(machine.calls.map((call) => call[1]));
    expect([...verbs].sort()).toEqual(
      [
        'agents.listManagement',
        'github.listAccounts',
        'integrations.checkAllConnections',
        'integrations.checkConfiguredConnections',
        'integrations.list',
        'promptLibrary.get',
      ].sort()
    );
    expect(machine.calls.every((call) => call[0] === 'd22')).toBe(true);
    // 集成清单带上这台桌面的界面语言:那台机器的主进程按它把插件的中英两份解析成字符串(复核 93 ①)。
    const { getSessionLocaleSnapshot } = await import('@renderer/localization/locale-store');
    expect(machine.calls.find((call) => call[1] === 'integrations.list')?.[2]).toEqual([
      getSessionLocaleSnapshot().resolvedLocale,
    ]);
    expect(local.promptLibrary.get).not.toHaveBeenCalled();
    expect(local.integrations.checkAllConnections).not.toHaveBeenCalled();
    expect(local.github.listAccounts).not.toHaveBeenCalled();
    expect(local.agents.listManagement).not.toHaveBeenCalled();
    expect(seen?.prompts.value.map((p) => p.id)).toEqual(['d22-prompt']);
    expect(seen?.integrations.integrations.map((i) => i.id)).toEqual(['linear']);
  });

  it('选了 d22 再写:提示词写回的是 d22 那一份', async () => {
    const host = createRemoteLibraryHost({ deviceId: 'd22', deviceLabel: 'Linux 1', online: true, lastSeenAt: null });
    await render(
      React.createElement(LibraryHostProvider, { value: host }, React.createElement(IntegrationsProvider, null, probe()))
    );
    await settle();
    act(() => seen!.prompts.update([{ id: 'new', title: 'N', text: 'n' } as never]));
    await settle();
    expect(machine.calls).toContainEqual(['d22', 'promptLibrary.update', [[{ id: 'new', title: 'N', text: 'n' }]]]);
    expect(local.promptLibrary.update).not.toHaveBeenCalled();
  });

  it('d22 离线:哪一格都不去问(问不到只会挂满超时)', async () => {
    const host = createRemoteLibraryHost({ deviceId: 'd22', deviceLabel: 'Linux 1', online: false, lastSeenAt: null });
    await render(
      React.createElement(LibraryHostProvider, { value: host }, React.createElement(IntegrationsProvider, null, probe()))
    );
    await settle();
    expect(machine.calls).toEqual([]);
  });

  it('没挂资源库机器的地方(输入框的「添加上下文」、聊天里的 @issue)= 本机', async () => {
    await render(React.createElement(IntegrationsProvider, null, probe()));
    await settle();
    expect(local.promptLibrary.get).toHaveBeenCalled();
    expect(local.integrations.list).toHaveBeenCalled();
    expect(local.integrations.checkAllConnections).toHaveBeenCalled();
    expect(local.github.listAccounts).toHaveBeenCalled();
    expect(seen?.prompts.value.map((p) => p.id)).toEqual(['local-prompt']);
  });

  it('扩展:看咕咕 server 时是那台的卡片(161 10-15:server 照样装 App,人在这里看、卸),上头如实说它没有窗口', async () => {
    const host = createRemoteLibraryHost({
      deviceId: 'd22',
      deviceLabel: 'Linux 1',
      online: true,
      lastSeenAt: null,
      hostKind: 'server',
    });
    await render(React.createElement(LibraryHostProvider, { value: host }, React.createElement(ExtensionsLibraryPage)));
    const doc = dom.window.document;
    expect(doc.querySelector('[data-testid="local-extensions"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="extensions-on-server"]')?.textContent).toContain('Linux 1');

    await render(React.createElement(ExtensionsLibraryPage));
    expect(doc.querySelector('[data-testid="local-extensions"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="extensions-on-server"]')).toBeNull();
  });

  it('扩展:看另一台咕咕桌面时是同一张卡片(那台机器的清单),❌ 那句「没有窗口」', async () => {
    const host = createRemoteLibraryHost({
      deviceId: 'mac2',
      deviceLabel: 'MacBook',
      online: true,
      lastSeenAt: null,
      hostKind: 'desktop',
    });
    await render(React.createElement(LibraryHostProvider, { value: host }, React.createElement(ExtensionsLibraryPage)));
    const doc = dom.window.document;
    expect(doc.querySelector('[data-testid="local-extensions"]')).not.toBeNull();
    expect(doc.querySelector('[data-testid="extensions-on-server"]')).toBeNull();
    expect(host.extensions.local).toBe(false);
  });
});
