import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HarnessCatalogLookup } from '@main/core/agents/harness-model-catalog';

const mocks = vi.hoisted(() => ({ modelCatalog: vi.fn() }));

vi.mock('@renderer/lib/ipc', () => {
  const rpc = { agents: { modelCatalog: mocks.modelCatalog } };
  return { rpc, rpcOn: () => rpc };
});
vi.mock('@renderer/features/library/library-host', () => ({ useLibraryHost: () => ({ remote: null }) }));
vi.mock('@renderer/localization/locale-store', () => ({ translateSessionMessage: (key: string) => key }));
vi.mock('./use-agent-auth-status', () => ({ useAgentAuthStatus: () => ({ auth: undefined }) }));

const { useHarnessModelCatalog } = await import('./use-harness-model-catalog');

function lookup(haiku: string): HarnessCatalogLookup {
  return {
    state: {
      kind: 'ready',
      models: [{ id: 'default', name: 'Default' }, { id: 'haiku', name: haiku }],
      selected: 'default',
      efforts: [],
      selectedEffort: null,
    },
    refreshing: false,
  } as unknown as HarnessCatalogLookup;
}

function ModelList() {
  const { state } = useHarnessModelCatalog('claude', 'acp');
  const haiku = state.kind === 'ready' ? state.models.find((m) => m.id === 'haiku')?.name : state.kind;
  return React.createElement('span', { 'data-testid': 'haiku' }, haiku ?? '');
}

/**
 * #7081:作废归主进程管(它按输入指纹认出就地升级),可主进程只在**被问到**时才比指纹。
 * 本机这份 `staleTime: Infinity` ⇒ 面一挂上来就该问一次,否则 5 分钟内重开的新建任务页
 * (或者别处一直挂着同一份清单时)永远显示升级前那份。
 */
describe('useHarnessModelCatalog —— 本机清单每次打开都问主进程', () => {
  let dom: JSDOM;
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    client = new QueryClient();
    container = dom.window.document.getElementById('root') as HTMLDivElement;
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    client.clear();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  // React Query 的通知批排在 setTimeout(0) 上:渲染之后让它跑完再读。
  const render = async (node: React.ReactNode) => {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client }, node));
    });
    await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  };
  const shown = () => container.querySelector('[data-testid="haiku"]')?.textContent;

  it('关掉再打开 → 重新问主进程,显示它此刻的答案', async () => {
    mocks.modelCatalog.mockResolvedValue(lookup('Haiku 4.5'));
    await render(React.createElement(ModelList));
    expect(shown()).toBe('Haiku 4.5');

    await render(null);
    // 其间 harness 就地升级,主进程的指纹认出来了。
    mocks.modelCatalog.mockResolvedValue(lookup('Haiku 5.5'));
    await render(React.createElement(ModelList));

    expect(mocks.modelCatalog).toHaveBeenCalledTimes(2);
    expect(shown()).toBe('Haiku 5.5');
  });

  /** 阴控:问的时机是「挂上来」,❌ 不是每次重渲染 —— 那会变成每帧一趟 IPC。 */
  it('挂着时重渲染 → 不再问', async () => {
    mocks.modelCatalog.mockResolvedValue(lookup('Haiku 4.5'));
    await render(React.createElement(ModelList));
    await render(React.createElement(ModelList));
    await render(React.createElement(ModelList));

    expect(mocks.modelCatalog).toHaveBeenCalledTimes(1);
  });
});
