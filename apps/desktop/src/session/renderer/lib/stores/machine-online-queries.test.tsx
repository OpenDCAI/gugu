// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// #137 新建框问的这几样(名单、目录、凭据)都在选着的那台机器上:没连上就不问,连上了自己去取;
// 不问的时候 ❌ 报「正在读取」—— 那一格会一直转到机器回来,而原因由机器的提示说。
const mocks = vi.hoisted(() => ({
  host: { remote: { deviceId: 'mac-1', online: false } as { deviceId: string; online: boolean } },
  list: vi.fn(),
  modelCatalog: vi.fn(),
  modelCredential: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: {},
  rpcOn: () => ({ agents: { list: mocks.list, modelCatalog: mocks.modelCatalog } }),
}));
vi.mock('@renderer/features/library/library-host', () => ({ LOCAL_HOST_KEY: 'local', useLibraryHost: () => mocks.host }));
vi.mock('@renderer/lib/agent-config/runtime-client', () => ({
  getAgentConfigRuntimeClient: async () => ({ modelCredential: mocks.modelCredential }),
}));
vi.mock('./use-agent-auth-status', () => ({ useAgentAuthStatus: () => ({ auth: null }) }));

import { useAgents } from './use-agents';
import { useHarnessModelCatalog } from './use-harness-model-catalog';
import { useHarnessModelCredential } from './use-harness-model-credential';

let seen: { agentsLoading: boolean; agents: unknown; catalog: string; credential: string } | null = null;
function Probe() {
  const agents = useAgents();
  const catalog = useHarnessModelCatalog('claude', 'acp');
  const credential = useHarnessModelCredential('claude', 'opus');
  seen = { agentsLoading: agents.isLoading, agents: agents.data, catalog: catalog.state.kind, credential: credential.status };
  return null;
}

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
// react-query 把结果推给组件排在下一个 setTimeout 里
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
async function render(online: boolean) {
  mocks.host.remote = { deviceId: 'mac-1', online };
  await act(async () => {
    root.render(<QueryClientProvider client={client}><Probe /></QueryClientProvider>);
  });
  await settle();
}

beforeEach(() => {
  mocks.list.mockReset();
  mocks.modelCatalog.mockReset();
  mocks.modelCredential.mockReset();
  client = new QueryClient();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  client.clear();
});

describe('新建框跟着那台机器连没连上去问', () => {
  it('没连上:三样都不问,名单那一格也不说「正在读取」', async () => {
    await render(false);
    expect(mocks.list).not.toHaveBeenCalled();
    expect(mocks.modelCatalog).not.toHaveBeenCalled();
    expect(mocks.modelCredential).not.toHaveBeenCalled();
    expect(seen?.agentsLoading).toBe(false);
  });

  it('连上那一刻:自己去取,取的时候说「正在读取」,取到就是那台机器的', async () => {
    await render(false);
    let answer: (agents: unknown[]) => void = () => {};
    mocks.list.mockReturnValue(new Promise((resolve) => { answer = resolve; }));
    mocks.modelCatalog.mockResolvedValue({ state: { kind: 'unsupported' }, refreshing: false });
    mocks.modelCredential.mockResolvedValue({ success: true, data: 'credentialed' });
    await render(true);
    expect(seen?.agentsLoading).toBe(true);
    await act(async () => answer([{ id: 'claude' }]));
    await settle();
    expect(seen?.agentsLoading).toBe(false);
    expect(seen?.agents).toEqual([{ id: 'claude' }]);
    expect(seen?.catalog).toBe('unsupported');
    expect(seen?.credential).toBe('credentialed');
    expect(mocks.list).toHaveBeenCalledTimes(1);
    expect(mocks.modelCatalog).toHaveBeenCalledTimes(1);
    expect(mocks.modelCredential).toHaveBeenCalledTimes(1);
  });
});
